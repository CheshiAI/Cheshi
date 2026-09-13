//! C# extraction — a faithful Rust port of `TreeSitterExtractor`'s C# paths
//! (src/extraction/tree-sitter.ts) plus languages/csharp.ts.
//!
//! Same porting contract as the other walkers: behavior parity with the wasm
//! path, bug-for-bug, verified by `bun run kernel:parity` and the full-index
//! dump-diff gate, including every deliberate
//! emission hole (property/accessor bodies, constructor initializers,
//! delegates/events/operators/indexers, top-level locals) and garbage ref
//! (`(repo)` primary-ctor extends, `: byte` enum extends, `nameof` calls)
//! this file preserves on purpose. Positions in UTF-16 code units. Files whose
//! parse tree contains ERRORS defer to the wasm extractor.
//!
//! preParse (#237 `#if` blanking) stays TS-side: the route point hoists it, so
//! the kernel receives pre-blanked bytes — port NOTHING of it here (its regex
//! carries JS `(?m)`/CRLF semantics that must not be re-implemented).

use crate::buffers::{
    edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow, NodeRowInput,
    StrRef, FLAG_IS_ASYNC, FLAG_IS_STATIC, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use std::ops::{Deref, DerefMut};
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

type Scope = util::Scope;

type Extra = util::NodeExtra;

type ValueScope<'t> = util::ValueScope<'t>;
type Cand = util::FnRefCandidate;

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
    let grammar = crate::langs::grammar_for("csharp").ok_or("no csharp grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "csharp")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
    };

    // File node (TreeSitterExtractor.extract). Source here is the pre-blanked
    // text (the route point hoists preParse), identical bytes on both arms.
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
        name: base_name,
    });

    // extractFilePackage: the FIRST top-level namespace declaration mints ONE
    // `namespace` node that stays pushed for the ENTIRE file — a second
    // top-level namespace's types nest under the first's node/QN, nested
    // namespaces leave no trace, and every import ref in a namespaced file
    // hangs off this node (checklist §namespace).
    let root = tree.root_node();
    let mut pkg_pushed = false;
    for child in util::named_children(root) {
        if child.kind() != "namespace_declaration"
            && child.kind() != "file_scoped_namespace_declaration"
        {
            continue;
        }
        // csharpExtractor.extractPackage: `name` field ?? first
        // qualified_name/identifier named child. No trim.
        let name_node = child.child_by_field_name("name").or_else(|| {
            util::named_children(child)
                .find(|c| matches!(c.kind(), "qualified_name" | "identifier"))
        });
        let Some(name_node) = name_node else {
            break;
        };
        let pkg = util::source_text(w.src, name_node).to_string();
        if pkg.is_empty() {
            break;
        }
        if let Some(row) = w.create_node("namespace", &pkg, child, Extra::default()) {
            util::push_scope(&mut w.stack, row, "namespace", pkg);
            pkg_pushed = true;
        }
        break;
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

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
