//! Scala extraction — a faithful Rust port of the scala paths of
//! `TreeSitterExtractor` (src/extraction/tree-sitter.ts) plus
//! languages/scala.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug,
//! including the load-bearing oddities this file preserves on purpose:
//! functionTypes is EMPTY so every def routes through extractMethod (top level
//! falls back to a `function` node); NO namespace node ever (package headers
//! ignored, QNs bare); imports are named the FIRST path segment (`import
//! com.example.C` → `com`); the val/var hook keys on the enclosing-definition
//! NODE TYPE (object vals → constants, class/trait/enum/given vals → fields)
//! and consumes the initializer (no calls/instantiates from hook-consumed
//! initializers); extension methods mint NO nodes (the first def's body calls
//! leak to the enclosing scope, every later def is invisible, and the braced
//! form resolves its `body` field to the `{` TOKEN — whole extension
//! invisible); anonymous `new T { … }` bodies leak their defs to the
//! enclosing scope (findAnonymousClassBody misses template_body); nested
//! defs in bodies mint NOTHING (inverse of kotlin); the bodied-vs-bodiless
//! class asymmetry (bodiless headers walk class_parameters → default-value
//! calls emit from the class; bodied ones never see them); curried signatures
//! keep only the FIRST parameter list and type params win the `parameters`
//! field; static-member WRITES emit (unlike kotlin); infix calls are
//! invisible; `derives` emits nothing; value-ref same-name targets take the
//! LAST registration. Positions in UTF-16 code units. Files with parse errors
//! defer to wasm — including scala-3 PHANTOM hasError files (flag-true, zero
//! ERROR nodes): trust the flag.

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

/// LITERAL_RECEIVER_TYPES (tree-sitter.ts:373-388).
fn is_literal_receiver(kind: &str) -> bool {
    util::is_literal_receiver_kind(kind)
}

/// BUILTIN_TYPES (tree-sitter.ts:5768-5782) — the shared cross-language table.
fn is_builtin_type(name: &str) -> bool {
    util::is_builtin_type_name(name)
}

/// SCALA_BUILTIN_TYPES (languages/scala.ts:14-17) — the hook's OWN smaller set.
fn is_scala_builtin(name: &str) -> bool {
    matches!(
        name,
        "Int"
            | "Long"
            | "Short"
            | "Byte"
            | "Float"
            | "Double"
            | "Boolean"
            | "Char"
            | "Unit"
            | "String"
            | "Any"
            | "AnyRef"
            | "AnyVal"
            | "Nothing"
            | "Null"
    )
}

/// extractScalaReturnType's simple-name gate (`/^[A-Za-z_]\w*$/`).
fn simple_type_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap())
}
/// extractScalaReturnType's generic-args strip (`/\[[^]]*\]/g`).
fn bracket_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[[^]]*\x5d").unwrap())
}
/// Static-member receiver gate (`/^[A-Z][A-Za-z0-9_]*$/`).
fn cap_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
/// The #750 re-encode gate (`/^[A-Z]/`).
fn starts_upper_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z]").unwrap())
}
/// JS `\s+` for the re-encode/return-type strips (Unicode whitespace).
fn ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

type Cand = util::FnRefCandidate;
type Extra = util::NodeExtra;
type Scope = util::Scope;
type ValueScope<'t> = util::ValueScope<'t>;

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
    let grammar = crate::langs::grammar_for("scala").ok_or("no scala grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "scala")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
    };

    // File node (tree-sitter.ts:508-521).
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

    // No packageTypes → no namespace node, ever.
    w.visit(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

mod declarations;
mod references;
mod value_references;
mod walker;
