//! Dart extraction — a faithful Rust port of the dart paths of
//! `TreeSitterExtractor` (src/extraction/tree-sitter.ts) plus
//! languages/dart.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The center of gravity is THE SIBLING-BODY DOUBLE-WALK: dart attaches every
//! function/method body as a NEXT SIBLING of its signature node, and the TS
//! walkers consume the body TWICE — once via resolveBody (attributed to the
//! function/method) and once via the enclosing generic walk (attributed to
//! the file/class). The deterministic result — duplicate local-function
//! nodes with the SAME id under different parents, duplicated
//! calls/instantiates refs, file/class-attributed fn-ref twins — must be
//! reproduced byte-for-byte in the observed interleave; a "helpful" dedupe
//! breaks parity. Other load-bearing oddities preserved on purpose:
//! callTypes is EMPTY (all call refs ride extractBareCall's selector
//! walking in the body walker — cascades are invisible, `?.` encodes like
//! `.`); `ConfigT.load()` double-emits (calls + a static-member references
//! ref — no callee-of-call skip in the dart branch); operator methods mint
//! `method "<anonymous>"`; the unnamed constructor is skipped
//! (isMisparsedFunction) while named ctors/factories are named by the CTOR
//! name with the class as returnType; instance fields mint NO nodes (only
//! static_final_declaration → constant, via the hook); prefixed return
//! types keep the PREFIX (`other.OtherClass f()` → returnType `other` —
//! bug, preserved); enum `with` mixins emit nothing while enum `implements`
//! works; deferred imports are invisible; named-argument callbacks are NOT
//! fn-ref-captured; `async*`/`sync*` are NOT async. Positions in UTF-16
//! code units. Files with parse errors defer to wasm (3.4–20.7% both-arm
//! incidence — empty object patterns and unnamed `library;` dominate).

use crate::buffers::{
    edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow, RefRow, StrRef,
    Tables, FLAG_IS_ASYNC, FLAG_IS_STATIC, NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    util::is_fn_ref_stoplisted(name)
}

/// BUILTIN_TYPES (tree-sitter.ts:5768-5782).
fn is_builtin_type(name: &str) -> bool {
    util::is_builtin_type_name(name)
}

/// extractDartReturnType's simple-name gate + the static-member receiver gate.
fn simple_type_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap())
}
fn cap_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
/// The chained-call re-encode gate (`/^[A-Z]/`).
fn starts_upper_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z]").unwrap())
}
/// extractDartReturnType's `<...>` strip (`/<[^>]*>/g`).
fn angle_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}

type Scope = util::Scope;

type Cand = util::FnRefCandidate;

type ValueScope<'t> = util::ValueScope<'t>;

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    /// 0 = absent; 1 public, 2 private.
    visibility: u8,
    is_async: Option<bool>,
    is_static: Option<bool>,
    return_type: Option<String>,
    /// resolveBody-driven endLine extension (LIVE for dart sibling bodies).
    end_line_override: Option<u32>,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    node_ids: Vec<String>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("dart").ok_or("no dart grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "dart")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        src: source,
        file_path,
        line_starts: util::line_starts(source),
        arena: Arena::default(),
        tables: Tables::default(),
        stack: Vec::new(),
        node_ids: Vec::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
        fs_values: HashMap::new(),
        fs_value_counts: HashMap::new(),
        value_scopes: Vec::new(),
    };

    // File node (tree-sitter.ts:508-521).
    let base_name = util::emit_file_node(
        file_path,
        source,
        &mut w.arena,
        &mut w.tables,
        &mut w.node_ids,
    );
    w.stack.push(Scope {
        row: 0,
        kind: "file",
        name: base_name.to_string(),
    });

    w.visit(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.tables, w.arena))
}

mod declarations;
mod references;
mod value_references;
mod walker;

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}

impl<'t> Walker<'t> {
    crate::walker_helper_methods!(class);
}
