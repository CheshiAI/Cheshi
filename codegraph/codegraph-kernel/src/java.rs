//! Java extraction — a faithful Rust port of `TreeSitterExtractor`'s Java
//! paths (src/extraction/tree-sitter.ts) plus languages/java.ts, including
//! the Lombok member synthesizer (#912).
//!
//! Same porting contract as tsjs/: behavior parity with the wasm path,
//! bug-for-bug, verified by `bun run kernel:parity` and the full-index
//! dump-diff gate. Positions in UTF-16 code units. Files whose parse tree
//! contains ERRORS defer to the wasm extractor (encoding-dependent recovery —
//! see tsjs/mod.rs).

use crate::buffers::{edge_kind_index, EmitOut};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

fn is_method_type(kind: &str) -> bool {
    matches!(kind, "method_declaration" | "constructor_declaration")
}
fn is_interface_type(kind: &str) -> bool {
    matches!(
        kind,
        "interface_declaration" | "annotation_type_declaration"
    )
}

/// JAVA_NON_CLASS_RETURN_NODES (languages/java.ts).
fn is_non_class_return(kind: &str) -> bool {
    matches!(
        kind,
        "void_type" | "integral_type" | "floating_point_type" | "boolean_type"
    )
}

/// BUILTIN_TYPES (tree-sitter.ts) — shared table; only the Java-relevant names
/// fire here but membership is what the TS code tests.
fn is_builtin_type(name: &str) -> bool {
    util::is_builtin_type_name(name)
}

/// LOMBOK_LOG_ANNOTATIONS (languages/java.ts).
fn is_lombok_log_annotation(name: &str) -> bool {
    matches!(
        name,
        "Slf4j"
            | "Log4j"
            | "Log4j2"
            | "Log"
            | "CommonsLog"
            | "JBossLog"
            | "Flogger"
            | "XSlf4j"
            | "CustomLog"
    )
}

fn generic_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
fn simple_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap())
}
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
fn method_ref_type_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([A-Z][A-Za-z0-9_]*)\s*::").unwrap())
}
fn is_prefix_re(word: &str) -> bool {
    // /^is[A-Z]/ for Lombok boolean getters.
    word.len() > 2 && word.starts_with("is") && word.as_bytes()[2].is_ascii_uppercase()
}

/// Per-node metadata kept for the Lombok synthesizer's taken-member scan
/// (mirrors its walk over ctx.nodes by qualifiedName).
struct NodeMeta {
    kind: &'static str,
    name: String,
    qualified_name: String,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    visibility: Option<u8>,
    is_static: Option<bool>,
    return_type: Option<String>,
    decorators: Option<Vec<String>>,
}

type Cand = util::FnRefCandidate;

pub struct Walker<'t> {
    state: util::WalkerState<'t>,
    nodes_meta: Vec<NodeMeta>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("java").ok_or("no java grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "java")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
        nodes_meta: Vec::new(),
    };

    // File node (TreeSitterExtractor.extract).
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
        qualified_name: file_path.to_string(),
    });
    util::push_scope(&mut w.state.stack, 0, "file", base_name);

    // extractFilePackage: wrap top-level declarations in a `namespace` node
    // carrying the package FQN.
    let root = tree.root_node();
    let mut pkg_pushed = false;
    if let Some((child, pkg)) = util::first_package_name(
        w.state.src,
        root,
        "package_declaration",
        &["scoped_identifier", "identifier"],
    ) {
        if let Some(row) = w.create_node("namespace", &pkg, child, Extra::default()) {
            util::push_scope(&mut w.state.stack, row, "namespace", pkg);
            pkg_pushed = true;
        }
    }

    w.visit_node(root);
    w.flush_fn_ref_candidates();
    w.flush_value_refs(root);
    if pkg_pushed {
        w.state.stack.pop();
    }
    w.state.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

mod declarations;
mod lombok;
mod references;
mod value_references;
mod walker;

fn find_anonymous_class_body(node: Node) -> Option<Node> {
    for i in 0..node.named_child_count() {
        if let Some(child) = node.named_child(i) {
            if matches!(child.kind(), "class_body" | "declaration_list") {
                return Some(child);
            }
        }
    }
    None
}

fn capitalize(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `\bword\b` matcher (modifier keyword tests in languages/java.ts).
fn word_re(word: &'static str) -> &'static Regex {
    static STATIC_RE: OnceLock<Regex> = OnceLock::new();
    static FINAL_RE: OnceLock<Regex> = OnceLock::new();
    match word {
        "static" => STATIC_RE.get_or_init(|| Regex::new(r"\bstatic\b").unwrap()),
        "final" => FINAL_RE.get_or_init(|| Regex::new(r"\bfinal\b").unwrap()),
        _ => unreachable!("word_re only supports static/final"),
    }
}

impl<'t> Walker<'t> {
    crate::walker_helper_methods!(state_class_no_line);
}
