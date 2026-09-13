//! PHP extraction — a faithful Rust port of `TreeSitterExtractor`'s PHP paths
//! (src/extraction/tree-sitter.ts) plus languages/php.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug,
//! including what this file preserves on purpose: the visitNode hook consumes
//! const_declaration (constants at ANY scope, values never walked) and
//! trait-`use` (implements refs WITH filePath — the v2 ref-flag wire slot,
//! shipped with ruby) before the ladder; the FIRST file-level namespace scopes
//! the whole walk (braced namespaces scope nothing); anonymous classes on the
//! v0.24.2 grammar mint NO anon-class node (top-level methods become file-level
//! functions, in-body methods vanish) and their instantiates ref is the whole
//! anon-class text run through the suffix logic; scoped calls are DOT-joined
//! (`UserModel.query`); `$this->prop->m()` emits `this->prop.m` (the #1251
//! machinery is resolution-side); nullsafe `?->` emits nothing; literal
//! receivers are not suppressed; interface multi-extends drops all but the
//! first base; property type-hints emit no refs from field nodes. Positions in
//! UTF-16 code units. Files with parse errors defer to wasm (≈0–0.1%).

use crate::buffers::{
    edge_kind_index, EmitOut, RefRow, FUNCTION_REF_CODE, NONE_STR, REF_FLAG_FILE_PATH,
};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use regex::Regex;
use std::collections::HashSet;
use std::ops::{Deref, DerefMut};
use std::sync::OnceLock;
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    util::is_fn_ref_stoplisted(name)
}

/// PHP_NON_CLASS_RETURN (languages/php.ts:37).
fn is_php_non_class_return(lc: &str) -> bool {
    matches!(
        lc,
        "array"
            | "string"
            | "int"
            | "integer"
            | "float"
            | "double"
            | "bool"
            | "boolean"
            | "void"
            | "mixed"
            | "never"
            | "null"
            | "false"
            | "true"
            | "object"
            | "callable"
            | "iterable"
            | "resource"
    )
}

/// PHP_PSEUDO_TYPES (tree-sitter.ts:5760).
fn is_php_pseudo_type(name: &str) -> bool {
    matches!(
        name,
        "self"
            | "static"
            | "parent"
            | "mixed"
            | "object"
            | "iterable"
            | "callable"
            | "void"
            | "null"
            | "false"
            | "true"
            | "never"
            | "array"
            | "int"
            | "float"
            | "string"
            | "bool"
    )
}

/// PHP_TYPE_NODES (tree-sitter.ts:310).
fn is_php_type_node(kind: &str) -> bool {
    matches!(
        kind,
        "named_type"
            | "optional_type"
            | "nullable_type"
            | "union_type"
            | "intersection_type"
            | "disjunctive_normal_form_type"
            | "primitive_type"
    )
}

/// PHP_CALLABLE_HOFS (function-ref.ts:347).
fn is_php_callable_hof(name: &str) -> bool {
    matches!(
        name,
        "array_map"
            | "array_filter"
            | "array_walk"
            | "array_walk_recursive"
            | "array_reduce"
            | "usort"
            | "uasort"
            | "uksort"
            | "array_udiff"
            | "array_udiff_assoc"
            | "array_uintersect"
            | "array_uintersect_assoc"
            | "call_user_func"
            | "call_user_func_array"
            | "forward_static_call"
            | "forward_static_call_array"
            | "preg_replace_callback"
            | "preg_replace_callback_array"
            | "register_shutdown_function"
            | "register_tick_function"
            | "set_error_handler"
            | "set_exception_handler"
            | "spl_autoload_register"
            | "ob_start"
            | "iterator_apply"
            | "header_register_callback"
            | "is_callable"
    )
}

/// `/^[A-Za-z_]\w*$/` with JS's ASCII `\w`.
fn ascii_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
}
/// String-callable simple-name shape (`/^[A-Za-z_][A-Za-z0-9_]*$/`).
fn simple_callable_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap())
}
/// String-callable qualified shape (`/^\w+::\w+$/`, JS ASCII `\w`).
fn qualified_callable_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9A-Za-z_]+::[0-9A-Za-z_]+$").unwrap())
}
type Scope = util::Scope;
type Extra = util::NodeExtra;

struct Cand {
    from: u32,
    name: String,
    line: u32,
    column_byte: usize,
    row: usize,
    skip_gate: bool,
}

pub struct Walker<'t> {
    state: util::WalkerState<'t>,
    fn_ref_cands: Vec<Cand>,
}

impl<'t> Deref for Walker<'t> {
    type Target = util::WalkerState<'t>;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

impl<'t> DerefMut for Walker<'t> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.state
    }
}

impl<'t> WalkerHelpers<'t> for Walker<'t> {
    fn walker_state(&self) -> &util::WalkerState<'t> {
        &self.state
    }
}

impl<'t> WalkerScope<'t> for Walker<'t> {
    fn walker_state_mut(&mut self) -> &mut util::WalkerState<'t> {
        &mut self.state
    }
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("php").ok_or("no php grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "php")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
        fn_ref_cands: Vec::new(),
    };

    let base_name = {
        let state = &mut w.state;
        util::emit_file_node(
            file_path,
            source,
            &mut state.arena,
            &mut state.tables,
            &mut state.node_ids,
        )
    };
    w.stack.push(Scope {
        row: 0,
        kind: "file",
        name: base_name.to_string(),
    });

    // extractFilePackage: the FIRST namespace_definition among the root's
    // direct namedChildren; braced namespaces (a compound_statement /
    // declaration_list child) make NO node and scope NOTHING. The node stays
    // pushed for the whole walk — QNs become `App\Services::Name` and import
    // nodes/refs hang off it.
    let root = tree.root_node();
    let mut pkg_pushed = false;
    for i in 0..root.named_child_count() {
        let Some(child) = root.named_child(i) else {
            continue;
        };
        if child.kind() != "namespace_definition" {
            continue;
        }
        let ns_name = (0..child.named_child_count())
            .filter_map(|j| child.named_child(j))
            .find(|c| c.kind() == "namespace_name");
        let has_body = (0..child.named_child_count())
            .filter_map(|j| child.named_child(j))
            .any(|c| matches!(c.kind(), "compound_statement" | "declaration_list"));
        if let Some(ns_name) = ns_name {
            if !has_body {
                let pkg = w.text(ns_name).to_string();
                if !pkg.is_empty() {
                    if let Some(row) = w.create_node("namespace", &pkg, child, Extra::default()) {
                        util::push_scope(&mut w.stack, row, "namespace", pkg);
                        pkg_pushed = true;
                    }
                }
            }
        }
        break;
    }

    w.visit_node(root);
    w.flush_fn_ref_candidates();
    w.flush_value_refs();
    if pkg_pushed {
        w.stack.pop();
    }
    w.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

mod declarations;
mod references;
mod value_references;
mod walker;

/// The function name node of the php call whose arguments contain `node` —
/// ≤4 parent hops to a function_call_expression; member/scoped calls abort
/// (method-call HOFs never qualify). (function-ref.ts:822)
fn php_enclosing_call_name(node: Node) -> Option<Node> {
    let mut cur = node.parent();
    for _ in 0..4 {
        let c = cur?;
        if c.kind() == "function_call_expression" {
            return c.child_by_field_name("function");
        }
        if matches!(
            c.kind(),
            "member_call_expression" | "scoped_call_expression"
        ) {
            return None;
        }
        cur = c.parent();
    }
    None
}

fn find_anonymous_class_body(node: Node) -> Option<Node> {
    util::named_children(node)
        .find(|child| matches!(child.kind(), "class_body" | "declaration_list"))
}

fn php_constructor_node(node: Node) -> Option<Node> {
    util::child_by_fields(node, &["constructor", "type", "name"], 0)
}
