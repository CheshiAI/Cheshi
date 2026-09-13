//! Rust-language extraction — a faithful port of `TreeSitterExtractor`'s rust
//! paths (src/extraction/tree-sitter.ts) plus languages/rust.ts. ("rustlang"
//! because `rust` alone collides with the kernel's own implementation
//! language.)
//!
//! Rust's shape quirks, mirrored exactly (bug-for-bug, all verified against
//! the TS reference):
//! - `isAsync` is dead code upstream: it scans DIRECT children for an `async`
//!   token, but the grammar nests it inside `function_modifiers` — every rust
//!   fn/method carries isAsync **false** (present-false, never absent).
//! - impl blocks push NO scope: members re-dispatch at file scope, so an impl
//!   associated `const` becomes a FILE-level `variable`, and the method↔owner
//!   `contains` edge is a source-order name scan (an impl ABOVE its struct
//!   gets no edge). `impl Trait for Generic<T>`'s receiver resolves to the
//!   TRAIT (the only direct type_identifier), and methods get QN
//!   `Trait::method` — preserve, never "fix" via the grammar's trait:/type:
//!   fields.
//! - `const_item`/`static_item` ride the generic extractVariable fallback:
//!   kind is always `variable`, no signature, and EVERY direct `identifier`
//!   child mints a node (`const MAX: u32 = OTHER;` → two nodes, `MAX` + the
//!   phantom `OTHER`). Top-level initializer values are never body-walked.
//! - Unit structs (`struct Unit;`, no body field) mint NO node; `mod_item`
//!   mints no module node and adds no QN prefix.
//! - Chained-call re-encode is scoped_identifier-gated (`Foo::new().bar()` →
//!   `Foo::new().bar`); instance chains, parens, `.await`, 2-hop fields, and
//!   `self` receivers all collapse to the bare method name (`self` is node
//!   kind `self`, not `identifier`, so it dodges SKIP_RECEIVERS by falling
//!   through). Turbofish callees keep the raw `helper::<T>` text.
//! - `use` emits an import node named by the ROOT module (`crate`/`self`/…),
//!   one root `imports` ref, then one FULL-path `imports` ref per binding;
//!   `use x::*` (use_wildcard) emits nothing at all.
//! - Trait supertraits come only from `trait_bounds`; a scoped supertrait
//!   (`fmt::Debug`) matches no case and is silently dropped.
//! - Rocket `routes!`/`catchers!` are extracted ONLY inside function bodies,
//!   and only when the macro name is a bare identifier.
//! - A rust type alias emits NO ref to its aliased type (the shared code
//!   reads a `value` field; rust's field is `type`).
//! - An `attribute_item` between a doc comment and its item breaks the
//!   docstring sibling chain (`#[derive(..)]` kills the docstring).
//!
//! Files with parse errors defer to wasm.

use crate::buffers::{edge_kind_index, EmitOut, RefRow, NONE_STR};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use regex::Regex;
use std::ops::{Deref, DerefMut};
use std::sync::OnceLock;
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

/// JS `/<[^>]*>/g` — the non-nested generic strip (breaks on nested generics
/// by design: `Result<Vec<Foo>, E>` → `Result, E>` → returnType undefined).
fn generic_angle_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
/// JS `/^[A-Za-z_]\w*$/` (ASCII \w — the regex crate's \w is Unicode).
fn simple_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
}

type Scope = util::Scope;
type Extra = util::NodeExtra;

type ValueScope<'t> = util::ValueScope<'t>;

/// Per-node metadata for the receiver-method owner lookup and
/// findNodeByName (mirrors the TS scans over `this.nodes` — FIRST match
/// wins, earlier-in-file only).
struct NodeMeta {
    kind: &'static str,
    name: String,
}

fn prior_owner_row(nodes: &[NodeMeta], receiver: &str) -> Option<u32> {
    nodes
        .iter()
        .position(|meta| {
            meta.name == receiver && matches!(meta.kind, "struct" | "class" | "enum" | "trait")
        })
        .map(|index| index as u32)
}

/// Resolve the trait-bound node shapes that the Rust adapter recognizes.
/// Scoped bounds intentionally remain unsupported to preserve the reference
/// extractor's behavior (`fmt::Debug` is not emitted as an `extends` ref).
fn rust_trait_bound_type(bound: Node) -> Option<Node> {
    match bound.kind() {
        "type_identifier" => Some(bound),
        "generic_type" => util::first_named_child_kind(bound, "type_identifier"),
        "higher_ranked_trait_bound" => util::first_named_child_kind(bound, "generic_type")
            .and_then(|generic| util::first_named_child_kind(generic, "type_identifier"))
            .or_else(|| util::first_named_child_kind(bound, "type_identifier")),
        _ => None,
    }
}

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
    let grammar = crate::langs::grammar_for("rust").ok_or("no rust grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "rust")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
        nodes_meta: Vec::new(),
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

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

mod declarations;
mod references;
mod value_references;
mod walker;

/// LITERAL_RECEIVER_TYPES (shared table).
fn is_literal_receiver(kind: &str) -> bool {
    util::is_literal_receiver_kind(kind)
}

/// BUILTIN_TYPES (shared table — port the WHOLE set: a rust `String`
/// type_identifier IS suppressed via the Scala row).
fn is_builtin_type(name: &str) -> bool {
    util::is_builtin_type_name(name)
}
