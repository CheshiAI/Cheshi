//! Swift extraction — a faithful Rust port of `TreeSitterExtractor`'s Swift
//! paths (src/extraction/tree-sitter.ts) plus languages/swift.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The port's center of gravity is the DEDICATED in-class property branch
//! (#1020 — Alamofire's 348 `property` nodes): computed properties become
//! `property` nodes whose getter walks with the property pushed; stored
//! `static let/var` → constant/variable, instance stored → field; decorator/
//! type-annotation/attr-arg refs all attach to the ENCLOSING TYPE; stored
//! declarations descend so initializer calls attribute to the class. Also
//! preserved on purpose: `parameter` field never resolves (zero param type
//! refs, zero signatures), isAsync is present-false (dead hook), `open` →
//! internal visibility, everything-is-`extends` inheritance (first
//! type_identifier of each specifier), no instantiates refs ever (`Foo()` is
//! a plain call), subscript reads as `calls arr`, `defer` as `calls defer`,
//! multi-case enum entries minting only the first case, `/** */` block docs
//! ignored AND chain-breaking, init/deinit/subscript minting no nodes with
//! their bodies routed through visitNode (calls → class, static reads →
//! nothing). Positions in UTF-16 code units. Files with parse errors defer
//! to wasm (structurally high incidence, 9–27% — the sweep runs
//! --max-deferral 0.3 by measured both-arm reality).

use crate::buffers::{edge_kind_index, EmitOut};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use std::collections::{HashMap, VecDeque};
use std::ops::{Deref, DerefMut};
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

/// BUILTIN_TYPES (tree-sitter.ts) — full shared table (`Bool` is NOT in it;
/// `Int`/`String`/`Double` are, via the Scala rows — checklist nuances).
fn is_builtin_type(name: &str) -> bool {
    util::is_builtin_type_name(name)
}

type Scope = util::Scope;

type Extra = util::NodeExtra;

type ValueScope<'t> = util::ValueScope<'t>;

struct SwiftPropInfo<'t> {
    name_node: Option<Node<'t>>,
    is_let: bool,
    is_computed: bool,
}

pub struct Walker<'t> {
    state: util::WalkerState<'t>,
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

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("swift").ok_or("no swift grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "swift")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
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

    // No packageTypes — swift has no namespace node; top-level QNs are bare.
    w.visit_node(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

/// firstSimpleIdentifier (tree-sitter.ts:261): BFS (FIFO), at most 40 nodes
/// popped, first `simple_identifier` wins.
fn first_simple_identifier<'t>(node: Option<Node<'t>>) -> Option<Node<'t>> {
    let mut q: VecDeque<Node<'t>> = VecDeque::new();
    if let Some(n) = node {
        q.push_back(n);
    }
    let mut guard = 0;
    while guard < 40 {
        let Some(n) = q.pop_front() else { break };
        guard += 1;
        if n.kind() == "simple_identifier" {
            return Some(n);
        }
        for child in util::named_children(n) {
            q.push_back(child);
        }
    }
    None
}

/// lastNamedOfType (function-ref.ts:600): rightmost matching DESCENDANT in
/// document order (deeper matches override).
fn last_simple_identifier<'t>(node: Node<'t>) -> Option<Node<'t>> {
    let mut found: Option<Node<'t>> = None;
    for child in util::named_children(node) {
        if child.kind() == "simple_identifier" {
            found = Some(child);
        }
        if let Some(deeper) = last_simple_identifier(child) {
            found = Some(deeper);
        }
    }
    found
}

mod declarations;
mod references;
mod value_references;
mod walker;

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
