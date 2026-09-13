//! Kotlin extraction — a faithful Rust port of `TreeSitterExtractor`'s Kotlin
//! paths (src/extraction/tree-sitter.ts) plus languages/kotlin.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! Two surfaces are FIRSTS for the kernel: extension-function receivers
//! (getReceiverType → `Type::method` qualified-name OVERRIDE with no package
//! prefix + the owner-contains fallback that excludes `interface` kinds and
//! is source-order dependent) and extractModifiers (expect/actual platform
//! modifiers → the node DECORATORS wire field, on every created node — the
//! KMP synthesizer's input). Preserved on purpose: the FIELD_COUNT-0 dead
//! cluster (no signatures, ZERO type-annotation refs), hook-consumed property
//! initializers emitting nothing, the bodiless-class header re-walk asymmetry,
//! enum-entry bodies being invisible, KDoc (`multiline_comment`) never being
//! a docstring AND chain-breaking, comment-gluing into import/package extents,
//! `@Anno(args)` emitting nothing while `@Anno` emits decorates, zero
//! instantiates refs (constructors are capitalized `calls`), the qualified-
//! receiver `com::qext` bug, the paren-then-lambda `trailing()` garbage
//! callee, and the packaged-file value-ref target drop (namespace parents are
//! not accepted). The fun-interface misparse-recovery hook branches are
//! DEFER-SHIELDED (every such file has_error → wasm) and are not ported.
//! Positions in UTF-16 code units. Expected deferral 4.7–8.5% (both-arm,
//! grammar-inherent — incl. phantom errors: trust the has_error FLAG).

use crate::buffers::{edge_kind_index, EmitOut};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use regex::Regex;
use std::ops::{Deref, DerefMut};
use std::sync::OnceLock;
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    util::is_fn_ref_stoplisted(name)
}

/// LITERAL_RECEIVER_TYPES (tree-sitter.ts:373) — full shared set.
fn is_literal_receiver(kind: &str) -> bool {
    util::is_literal_receiver_kind(kind)
}

/// `/^[A-Za-z_]\w*$/` with JS's ASCII `\w` (getReturnType's ident test).
fn ascii_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
}
/// JS `\s` for the #750 inner-callee strip.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}
fn strip_js_ws(s: &str) -> String {
    s.chars().filter(|c| !is_js_space(*c)).collect()
}

type Scope = util::Scope;

/// Per-node metadata for the extension-fn owner-contains lookup.
struct NodeMeta {
    kind: &'static str,
    name: String,
}

type Extra = util::NodeExtra;

pub struct Walker<'t> {
    state: util::WalkerState<'t>,
    nodes_meta: Vec<NodeMeta>,
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
    let grammar = crate::langs::grammar_for("kotlin").ok_or("no kotlin grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "kotlin")?;
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
    w.stack.push(Scope {
        row: 0,
        kind: "file",
        name: base_name,
    });

    // extractFilePackage: the FIRST package_header among root's direct named
    // children → namespace node (comment-glued extents included), pushed for
    // the whole walk.
    let root = tree.root_node();
    let mut pkg_pushed = false;
    if let Some((child, pkg)) =
        util::first_package_name(w.src, root, "package_header", &["identifier"])
    {
        if let Some(row) = w.create_node("namespace", &pkg, child, Extra::default()) {
            util::push_scope(&mut w.stack, row, "namespace", pkg);
            pkg_pushed = true;
        }
    }

    w.visit_node(root);
    w.flush_fn_ref_candidates();
    w.flush_value_refs(root);
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
