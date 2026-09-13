//! Go extraction — a faithful Rust port of `TreeSitterExtractor`'s Go paths
//! (src/extraction/tree-sitter.ts) plus languages/go.ts.
//!
//! Go's shape quirks, mirrored exactly: methods are top-level with a receiver
//! (qualifiedName override `Recv::name` + a contains edge to the FIRST
//! earlier-in-file struct of that name), structs/interfaces arrive as
//! `type_spec` and classify via the inner type node (struct embedding →
//! extends; interface method_elems become method nodes), composite literals
//! (`pkga.Widget{}`) keep their package qualifier as `instantiates` refs,
//! top-level var/const specs walk their initializers ATTRIBUTED to the
//! declared symbol (#693), 2-hop field chains (`t.conn.Exec`) keep the chain
//! (#1276), and `New().Method()` re-encodes as `New().Method` (#645/#608)
//! only for bare-identifier factories. Files with parse errors defer to wasm.

use crate::buffers::{edge_kind_index, EmitOut};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use regex::Regex;
use std::sync::OnceLock;
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;
const GO_FN_REF_STOP_KINDS: &[&str] = &[
    "function_declaration",
    "arrow_function",
    "function_expression",
    "lambda_literal",
    "lambda_expression",
];

fn receiver_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)").unwrap())
}
fn simple_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap())
}
fn go_two_hop_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*\.[A-Za-z_]\w*$").unwrap())
}
fn generic_angle_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
fn bracket_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[[^]]*]").unwrap())
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    is_exported: Option<bool>,
    return_type: Option<String>,
    qualified_name: Option<String>,
}

type Cand = util::FnRefCandidate;

/// Per-node metadata for the receiver-method owner lookup (mirrors the TS
/// side's scan over `this.nodes` — FIRST match wins, earlier-in-file only).
struct NodeMeta {
    kind: &'static str,
    name: String,
}

pub struct Walker<'t> {
    state: util::WalkerState<'t>,
    nodes_meta: Vec<NodeMeta>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("go").ok_or("no go grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "go")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
        nodes_meta: Vec::new(),
    };

    let base_name = util::emit_file_node(
        file_path,
        source,
        &mut w.state.arena,
        &mut w.state.tables,
        &mut w.state.node_ids,
    );
    w.nodes_meta.push(NodeMeta {
        kind: "file",
        name: base_name.clone(),
    });
    util::push_scope(&mut w.state.stack, 0, "file", base_name);

    w.visit_node(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.state.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

mod declarations;
mod references;
mod value_references;
mod walker;

fn is_stoplisted(name: &str) -> bool {
    util::is_fn_ref_stoplisted(name)
}

fn is_literal_receiver(kind: &str) -> bool {
    util::is_literal_receiver_kind(kind)
}

/// BUILTIN_TYPES (shared table).
fn is_builtin_type(name: &str) -> bool {
    util::is_builtin_type_name(name)
}

impl<'t> Walker<'t> {
    crate::walker_helper_methods!(state_class_no_position);
}
