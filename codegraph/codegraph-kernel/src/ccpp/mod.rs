//! C / C++ extraction — a faithful Rust port of `TreeSitterExtractor`'s c/cpp
//! paths (src/extraction/tree-sitter.ts) plus languages/c-cpp.ts, one dual-
//! language module flagged like tsjs/.
//!
//! The seven preParse blanking passes are NOT here: the TS route point
//! (src/extraction/kernel/index.ts) applies `extractor.preParse` before the
//! kernel call, so this walker receives the SAME blanked bytes the wasm
//! extractor parses (all blanks are equal-length-space replacements — every
//! offset survives). `.metal`/`.cu`/`.cuh` arrive as language 'cpp' with their
//! dialect blanks already applied.
//!
//! Quirks mirrored bug-for-bug (each pinned by the parity gates):
//!  - cpp namespace prefix stack (#1291): named `namespace a::b {` pushes the
//!    name AS WRITTEN onto the qualifiedName prefix; anonymous falls through.
//!    No namespace NODE is minted (#1093 crowd-out).
//!  - out-of-line `Cls::method` defs: name = LAST `::` segment of the
//!    declarator's qualified_identifier (BFS that skips parameter_list +
//!    trailing_return_type), receiver = the template-stripped qualifier,
//!    qualifiedName composed against the namespace prefix with the re-spelled-
//!    prefix anchor rule; owner `contains` edge to the FIRST earlier
//!    struct/class/enum/trait of the receiver's bare name.
//!  - macro-name salvage: recoverCppMacroDefinedName (ALL-CAPS macro def whose
//!    real name is the lone first argument) at resolveName, and
//!    recoverMangledCppName (glued "Ret name" → last token) as the universal
//!    post-hoc net for BOTH c and cpp.
//!  - `class MACRO Name` misparse residue: isMisparsedFunction drops the
//!    phantom function (name starts `namespace`, C++ keywords, or the bodyless
//!    class/struct `type` + non-function_declarator shape, #946/#1061) but
//!    still walks the body.
//!  - C file-scope variables: init/pointer/array declarators only — a BARE
//!    identifier declarator is the macro-prototype misparse and is skipped
//!    (loses uninit scalars by design); cpp declarations instead take the TS
//!    GENERIC fallback (direct identifier children only → `int x;` extracts,
//!    `int x = 5;` does not — bug-for-bug).
//!  - inheritance quirk: extractInheritance recurses into
//!    field_declaration_list, where a field_declaration with no DIRECT
//!    field_identifier child (pointer/array/method members) but a direct
//!    type_identifier emits an `extends` ref to that type (the Go-embedding
//!    branch matching c/cpp shapes). Kept: the parity gate pins today's graph.
//!  - static-member/value-read pass (cpp only): `field_expression` is in
//!    MEMBER_ACCESS_TYPES (listed for Scala, same node kind in cpp), so
//!    `Capitalized.member` / `Capitalized->member` VALUE reads emit
//!    `references` refs; qualified_identifier is checked too but its scope
//!    child is namespace_identifier/template_type/…, never a plain
//!    identifier, so it can't emit.
//!  - explicit operator calls (#1247) ride an ERROR child — but has_error()
//!    defers the whole file to wasm, so the ported branch is a faithful no-op
//!    here; kept so an error-free shape (if a grammar bump ever produces one)
//!    stays parity-true.
//!  - local fn-pointer fan-out (#932-adjacent): `auto k = &fn<…>;` records
//!    per-caller targets (insertion-ordered, branch reassignments accumulate);
//!    a later bare `k(args)` emits one `calls` ref PER target and suppresses
//!    the local name. Template args stripped like base-class refs (#1043).
//!  - stack construction (#1035): cpp `declaration` with class-like named
//!    `type` and an init_declarator whose value is argument_list /
//!    initializer_list → `instantiates` (most-vexing-parse excluded).
//!  - value-reference edges: C only (VALUE_REF_LANGS has 'c', not 'cpp') —
//!    shadow prune via init_declarator counts, MAX_VALUE_REF_NODES cap,
//!    CODEGRAPH_VALUE_REFS=0 kill switch.
//!  - fn-ref capture (#756): cFamilySpec for both; cpp adds addressOfOnly
//!    (bare identifiers only qualify in file-scope value/list positions).
//!
//! Files with parse errors defer to wasm (`defer:`) — error recovery is
//! encoding-dependent and the wasm recovery is canonical.

use crate::buffers::{
    edge_kind_index, Arena, EdgeRow, EmitOut, RefRow, StrRef, Tables, FUNCTION_REF_CODE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::textutil::{self as util, named_children};
use regex::Regex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;

// --- compiled regexes (JS \w/\s spelled as ASCII classes for parity) ---------

/// recoverCppMacroDefinedName: macro-shaped parsed name.
fn macro_shaped_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$").unwrap())
}
fn has_lower_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[a-z]").unwrap())
}
/// normalizeCppReturnType: smart-pointer/optional unwrap.
fn ret_wrapper_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\b(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr|optional)\s*<\s*([^,>]+?)\s*>",
        )
        .unwrap()
    })
}
fn ret_keyword_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(?:const|volatile|typename|struct|class|enum)\b").unwrap())
}
fn angle_group_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
fn ptr_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[*&]+").unwrap())
}
fn ws_run_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}
fn simple_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap())
}
/// recoverMangledCppName's `Ret (name)` idiom guard.
fn ret_paren_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\S+\s+\([A-Za-z_][A-Za-z0-9_]*\)").unwrap())
}
/// Operator-call receiver: simple identifier / dotted member chain.
fn operator_receiver_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_.]*$").unwrap())
}
/// Symbolic operator tail (`/^[^\w\s]/` in JS).
fn symbolic_op_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[^A-Za-z0-9_\s]").unwrap())
}
/// extractStaticMemberRef's capitalized-receiver test.
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
/// normalizeValue's qualified `&Cls::m` member-pointer test (`/^[A-Za-z_][\w:]*$/`).
fn qualified_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_:]*$").unwrap())
}

const CPP_NON_CLASS_RETURNS: &[&str] = &[
    "void",
    "bool",
    "char",
    "short",
    "int",
    "long",
    "float",
    "double",
    "unsigned",
    "signed",
    "size_t",
    "ssize_t",
    "auto",
    "wchar_t",
    "char8_t",
    "char16_t",
    "char32_t",
    "int8_t",
    "int16_t",
    "int32_t",
    "int64_t",
    "uint8_t",
    "uint16_t",
    "uint32_t",
    "uint64_t",
    "intptr_t",
    "uintptr_t",
    "nullptr_t",
];

/// CPP_NON_CLASS_RETURN (languages/c-cpp.ts).
fn is_non_class_return(name: &str) -> bool {
    CPP_NON_CLASS_RETURNS.contains(&name)
}

const CPP_PRIMITIVE_NAMES: &[&str] = &[
    "bool", "void", "int", "char", "short", "long", "float", "double", "unsigned", "signed",
    "wchar_t", "char8_t", "char16_t", "char32_t", "char_t", "size_t", "auto", "const", "struct",
    "class", "enum", "union", "typename",
];

/// CPP_PRIMITIVE_NAMES (languages/c-cpp.ts) — recoverMangledCppName's guard.
fn is_cpp_primitive_name(name: &str) -> bool {
    CPP_PRIMITIVE_NAMES.contains(&name)
}

const NAME_STOPLIST: &[&str] = &[
    "this",
    "self",
    "super",
    "null",
    "nil",
    "true",
    "false",
    "undefined",
    "new",
    "NULL",
    "nullptr",
    "None",
];

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    NAME_STOPLIST.contains(&name)
}

fn is_literal_receiver(kind: &str) -> bool {
    util::is_literal_receiver_kind(kind)
}

/// stripCppTemplateArgs (languages/c-cpp.ts): depth-counted removal of every
/// balanced `<…>` group; `<` and `>` never reach the output.
fn strip_cpp_template_args(name: &str) -> String {
    if !name.contains('<') {
        return name.to_string();
    }
    let mut out = String::with_capacity(name.len());
    let mut depth = 0u32;
    for ch in name.chars() {
        if ch == '<' {
            depth += 1;
        } else if ch == '>' {
            depth = depth.saturating_sub(1);
        } else if depth == 0 {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// recoverMangledCppName (languages/c-cpp.ts) — universal post-hoc salvage for
/// a name still mangled by an unblanked macro ("Ret name" → "name").
fn recover_mangled_cpp_name(name: String) -> String {
    if !name.chars().any(|c| c.is_whitespace())
        || name.starts_with("operator")
        || name.starts_with('~')
    {
        return name;
    }
    if ret_paren_name_re().is_match(&name) {
        return name; // `Ret (name)` idiom — leave alone
    }
    let before_params = match name.find('(') {
        Some(i) => &name[..i],
        None => &name[..],
    };
    // (JS: `beforeParams.trim().split(/\s+/)` — split_whitespace already
    // ignores leading/trailing whitespace, so no explicit trim.)
    let candidate = before_params.split_whitespace().last().unwrap_or("");
    if candidate.is_empty()
        || !simple_ident_re().is_match(candidate)
        || is_cpp_primitive_name(candidate)
    {
        return name;
    }
    candidate.to_string()
}

/// normalizeCppReturnType (languages/c-cpp.ts).
fn normalize_cpp_return_type(raw: &str) -> Option<String> {
    let mut t = raw.trim().to_string();
    if t.is_empty() {
        return None;
    }
    if let Some(c) = ret_wrapper_re().captures(&t) {
        if let Some(inner) = c.get(1) {
            t = inner.as_str().to_string();
        }
    }
    let t = ret_keyword_re().replace_all(&t, " ");
    let t = angle_group_re().replace_all(&t, " ");
    let t = ptr_ref_re().replace_all(&t, " ");
    let t = ws_run_re().replace_all(&t, " ");
    let t = t.trim();
    if t.is_empty() {
        return None;
    }
    let parts: Vec<&str> = t.split("::").filter(|p| !p.is_empty()).collect();
    let last = *parts.last()?;
    if is_non_class_return(last) || !simple_ident_re().is_match(last) {
        return None;
    }
    Some(last.to_string())
}

/// JS `String.replace(/->/g,'.').replace(/\s+/g,'')` used on receivers.
fn arrow_dot_no_ws(s: &str) -> String {
    s.replace("->", ".")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

fn normalize_cpp_callee_name(mut name: String) -> String {
    name = util::normalize_parenthesized_name(&name);
    if name.contains('<') && !name.contains("operator") {
        name = strip_cpp_template_args(&name);
    }
    name
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    C,
    Cpp,
}

type Scope = util::Scope;

type Extra = util::NodeExtra;

type ValueScope<'t> = util::ValueScope<'t>;

/// Capture mode for a fn-ref candidate (gate policy keys on it).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Args,
    Rhs,
    Value,
    List,
    Varinit,
}

struct Cand {
    from: u32,
    name: String,
    mode: Mode,
    explicit_ref: bool,
    line: u32,
    column_byte: usize,
    row: usize,
}

/// Per-node metadata for the receiver-method owner lookup (mirrors the TS
/// side's scan over `this.nodes` — FIRST match wins, earlier-in-file only).
struct NodeMeta {
    kind: &'static str,
    name: String,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    variant: Variant,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    nodes_meta: Vec<NodeMeta>,
    node_ids: Vec<String>,
    /// C/C++ enclosing `namespace ns { … }` names (cpp only ever non-empty).
    namespace_prefix: Vec<String>,
    /// cppLocalFnPtrs: caller row → local name → insertion-ordered targets.
    local_fn_ptrs: HashMap<u32, HashMap<String, Vec<String>>>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str, language: &str) -> Result<EmitOut, String> {
    let variant = match language {
        "c" => Variant::C,
        "cpp" => Variant::Cpp,
        other => return Err(format!("ccpp walker got language '{other}'")),
    };
    let grammar = crate::langs::grammar_for(language).ok_or("no c/cpp grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language({language}) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    // Measurement hatch (parity sweeps only — never set in production): skip
    // the defer so the sweep can QUANTIFY how often UTF-8 vs UTF-16 error
    // recovery actually diverges on this language's erroring files.
    let no_defer = std::env::var("CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT").as_deref() == Ok("1");
    if tree.root_node().has_error() && !no_defer {
        return Err("defer: parse tree contains errors — wasm recovery is canonical".to_string());
    }

    let mut w = Walker {
        src: source,
        file_path,
        variant,
        line_starts: util::line_starts(source),
        arena: Arena::default(),
        tables: Tables::default(),
        stack: Vec::new(),
        nodes_meta: Vec::new(),
        node_ids: Vec::new(),
        namespace_prefix: Vec::new(),
        local_fn_ptrs: HashMap::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
        fs_values: HashMap::new(),
        fs_value_counts: HashMap::new(),
        value_scopes: Vec::new(),
    };

    let base_name = util::emit_file_node(
        file_path,
        source,
        &mut w.arena,
        &mut w.tables,
        &mut w.node_ids,
    );
    w.nodes_meta.push(NodeMeta {
        kind: "file",
        name: base_name.clone(),
    });
    w.stack.push(Scope {
        row: 0,
        kind: "file",
        name: base_name,
    });

    w.visit_node(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.tables, w.arena))
}

mod declarations;
mod references;
mod value_references;
mod walker;

// --- free helpers ------------------------------------------------------------

/// findDeclaratorQualifiedId (languages/c-cpp.ts:13): BFS for the declarator's
/// `qualified_identifier`, skipping parameter_list + trailing_return_type so a
/// qualified PARAMETER type can't be mistaken for the method name.
fn find_declarator_qualified_id(declarator: Node) -> Option<Node> {
    let mut queue: VecDeque<Node> = VecDeque::new();
    queue.push_back(declarator);
    while let Some(current) = queue.pop_front() {
        if current.kind() == "qualified_identifier" {
            return Some(current);
        }
        for child in named_children(current) {
            if child.kind() != "parameter_list" && child.kind() != "trailing_return_type" {
                queue.push_back(child);
            }
        }
    }
    None
}

/// cDeclaratorIdentifier (tree-sitter.ts:234): resolve the declared identifier
/// through init/pointer/array/parenthesized declarator wrappers; a
/// function_declarator means prototype/fn-ptr — null. (The C grammar's
/// parenthesized_declarator exposes no `declarator` field, so that arm always
/// terminates — bug-for-bug with getChildByField returning null there.)
fn c_declarator_identifier(node: Node) -> Option<Node> {
    let mut cur = Some(node);
    let mut guard = 0;
    while let Some(n) = cur {
        guard += 1;
        if guard > 12 {
            return None;
        }
        match n.kind() {
            "identifier" => return Some(n),
            "function_declarator" => return None,
            "init_declarator"
            | "pointer_declarator"
            | "array_declarator"
            | "parenthesized_declarator" => {
                cur = n.child_by_field_name("declarator");
            }
            _ => return None,
        }
    }
    None
}

/// isMacroMisparsedTypeDecl (languages/c-cpp.ts:261): `class MACRO Name {…}`
/// misparse residue — bodyless class/struct specifier in `type` + a
/// non-function_declarator declarator.
fn is_macro_misparsed_type_decl(node: Node) -> bool {
    let Some(type_node) = node.child_by_field_name("type") else {
        return false;
    };
    if type_node.kind() != "class_specifier" && type_node.kind() != "struct_specifier" {
        return false;
    }
    let has_body = named_children(type_node).any(|c| c.kind() == "field_declaration_list");
    if has_body {
        return false;
    }
    if let Some(declarator) = node.child_by_field_name("declarator") {
        if declarator.kind() == "function_declarator" {
            return false;
        }
    }
    true
}

/// hasFunctionAncestor (tree-sitter.ts:295).
fn has_function_ancestor(node: Node) -> bool {
    let mut p = node.parent();
    while let Some(n) = p {
        if n.kind() == "function_definition" {
            return true;
        }
        p = n.parent();
    }
    false
}

impl<'t> Walker<'t> {
    crate::walker_helper_methods!(class_no_end);
    crate::node_row_emitter_method!();
}
