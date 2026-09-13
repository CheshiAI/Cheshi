//! R extraction — a faithful Rust port of the R paths of `TreeSitterExtractor`
//! (src/extraction/tree-sitter.ts) plus languages/r.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! R is the lightest shared-surface port and the heaviest hook port: r.ts has
//! every type list empty except `callTypes: ['call']`, so the whole shared
//! extraction machine (extractFunction/Class/Import/Variable, docstrings,
//! decorators, inheritance, visitFunctionBody, value-refs, fn-refs,
//! static-member reads, type annotations) never runs — the walker is a file
//! node + the visitNode hook + the generic extractCall + pre-order recursion.
//! Load-bearing oddities preserved on purpose: `calls "return"` on every
//! `return(x)` (return/next/break are named nodes in v1.2.0), silent
//! consumption of imports with dynamic/missing/empty first args (subtree
//! never visited) vs class/generic calls FALLING THROUGH on the same shapes
//! (generic call + file-scope body leak), `library(help = pkg)` importing the
//! named arg's value, class-idiom variable suppression checking only the
//! callee NAME, chained `a <- b <- 5` minting only `a`, `env$fn <- function`
//! minting nothing while its body calls leak to file scope, raw-text callees
//! verbatim (`pkg::fn`, `obj$meth`, `"strfn"` quotes kept), and duplicate
//! same-(kind,name,line) ids emitted twice. Positions in UTF-16 code units.
//! Files with parse errors defer to wasm (~0% incidence on real repos).

use crate::buffers::{edge_kind_index, EmitOut};
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use regex::Regex;
use std::ops::{Deref, DerefMut};
use std::sync::OnceLock;
use tree_sitter::Node;

/// CONSTANT_NAME (r.ts:43) — ALL_CAPS or DOTTED.CAPS top-level assignment.
fn constant_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9._]*$").unwrap())
}

/// ASSIGN_LEFT / ASSIGN_RIGHT (r.ts:37-38).
fn is_assign_left(op: &str) -> bool {
    matches!(op, "<-" | "<<-" | "=")
}
fn is_assign_right(op: &str) -> bool {
    matches!(op, "->" | "->>")
}

/// IMPORT_FNS (r.ts:39) — `source` is checked alongside (r.ts:189).
fn is_import_fn(name: &str) -> bool {
    matches!(
        name,
        "library" | "require" | "requireNamespace" | "loadNamespace"
    )
}
/// CLASS_FNS (r.ts:40).
fn is_class_fn(name: &str) -> bool {
    matches!(name, "setClass" | "setRefClass" | "R6Class" | "ggproto")
}
/// GENERIC_FNS (r.ts:41).
fn is_generic_fn(name: &str) -> bool {
    matches!(name, "setGeneric" | "setMethod")
}

type Scope = util::Scope;
type Extra = util::NodeExtra;

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
    let grammar = crate::langs::grammar_for("r").ok_or("no r grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "r")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
    };

    // File node (tree-sitter.ts:508-521) — the only node with isExported set.
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

    // extractFilePackage returns null (no packageTypes); both end-of-file
    // flushes are no-ops for R (no fnRefSpec, VALUE_REF_LANGS gate).
    w.visit(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

impl<'t> Walker<'t> {
    fn push_ref_at(&mut self, from_row: u32, name: &str, kind: &str, node: Node) {
        util::emit_state_ref_at(
            &mut self.state,
            from_row,
            name,
            edge_kind_index(kind).unwrap(),
            node,
        );
    }

    // --- createNode (tree-sitter.ts:1308) ---------------------------------
    // R extras carry only `signature` (or nothing): no docstring, visibility,
    // isStatic/isAsync/isExported, returnType, decorators — ever. The endLine
    // body-extension is dead (no resolveBody hook).

    fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        signature: Option<&str>,
    ) -> Option<u32> {
        util::emit_node_row(
            &mut self.state,
            kind,
            name,
            node,
            Extra {
                signature: signature.map(str::to_owned),
                ..Extra::default()
            },
        )
    }

    // --- r.ts helper transcriptions ---------------------------------------

    /// calleeName (r.ts:46-55): bare identifier text, or a
    /// namespace_operator's `rhs` field text (`pkg::fn` → `fn`) — so
    /// `methods::setClass` etc. trigger the special branches. Everything else
    /// (extract_operator, subset2, string, call, return…) → None.
    fn callee_name(&self, call: Node<'t>) -> Option<&'t str> {
        let f = call.child_by_field_name("function")?;
        match f.kind() {
            "identifier" => Some(self.text(f)),
            "namespace_operator" => f.child_by_field_name("rhs").map(|rhs| self.text(rhs)),
            _ => None,
        }
    }

    /// firstArgValue (r.ts:58-67): the FIRST `argument`-typed named child of
    /// the `arguments` field → its `value` field (named arguments are NOT
    /// skipped — `library(help = docpkg)` imports "docpkg", preserved bug).
    fn first_arg_value(&self, call: Node<'t>) -> Option<Node<'t>> {
        let args = call.child_by_field_name("arguments")?;
        for arg in util::named_children(args) {
            if arg.kind() != "argument" {
                continue;
            }
            return arg.child_by_field_name("value");
        }
        None
    }

    /// literalOrIdentifier (r.ts:70-81): identifier text (backticks kept), a
    /// string's first string_content text, `Some("")` for an empty string
    /// literal (falsy downstream, like null), None otherwise.
    fn literal_or_identifier(&self, node: Option<Node<'t>>) -> Option<&'t str> {
        let node = node?;
        match node.kind() {
            "identifier" => Some(self.text(node)),
            "string" => {
                for c in util::named_children(node) {
                    if c.kind() == "string_content" {
                        return Some(self.text(c));
                    }
                }
                Some("")
            }
            _ => None,
        }
    }

    // --- the visitNode walk (tree-sitter.ts:936-953, 1248, 1295-1301) -----
    // Hook first (consumed → return; scanFnRefSubtree is a no-op for R), then
    // the ladder — only callTypes can match, with children still recursed —
    // else plain recursion over namedChildren in order.

    fn visit(&mut self, node: Node<'t>) {
        if self.hook(node) {
            return;
        }
        if node.kind() == "call" {
            self.extract_call(node);
        }
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
    }

    /// The visitNode hook (r.ts:180-309). Returns true when consumed.
    fn hook(&mut self, node: Node<'t>) -> bool {
        match node.kind() {
            "call" => self.hook_call(node),
            "binary_operator" => self.hook_binary_operator(node),
            _ => false,
        }
    }

    fn hook_call(&mut self, node: Node<'t>) -> bool {
        let fname = match self.callee_name(node) {
            Some(f) => f,
            None => return false,
        };

        // library(dplyr) / require(stats) / requireNamespace("jsonlite") /
        // source("helpers.R") (r.ts:189-208). A dynamic/missing/empty first
        // arg is consumed SILENTLY — nothing recorded, subtree never visited.
        if is_import_fn(fname) || fname == "source" {
            let module = match self.literal_or_identifier(self.first_arg_value(node)) {
                Some(m) if !m.is_empty() => m,
                _ => return true,
            };
            // signature: whole call text .trim().slice(0, 100) — UTF-16 slice.
            // (A call node's text starts at the callee and ends at `)`, so
            // trim() never has anything to strip on reachable inputs.)
            let (sig, _) = util::slice_utf16(self.text(node).trim(), 100);
            let module = module.to_string();
            let imp = self.create_node("import", &module, node, Some(&sig));
            if imp.is_some() && !self.stack.is_empty() {
                let parent_row = self.top_row();
                self.push_ref_at(parent_row, &module, "imports", node);
            }
            return true;
        }

        // setClass("Patient", …) / setRefClass / R6Class / ggproto
        // (r.ts:211-221). A falsy name FALLS THROUGH to the generic call —
        // `ggproto(NULL, Geom, …)` emits `calls ggproto` + file-scope body
        // leak (asymmetric with imports, preserved).
        if is_class_fn(fname) {
            let name = match self.literal_or_identifier(self.first_arg_value(node)) {
                Some(n) if !n.is_empty() => n.to_string(),
                _ => return false,
            };
            if let Some(cls_row) = self.create_node("class", &name, node, None) {
                self.with_scope(cls_row, "class", name, |walker| {
                    walker.extract_class_members(node, cls_row);
                });
            }
            return true;
        }

        // setGeneric("describe", …) / setMethod("describe", "Patient", fn)
        // (r.ts:224-249): function node named by the first arg; signature and
        // body from the FIRST argument (any position) whose value is a
        // function_definition.
        if is_generic_fn(fname) {
            let name = match self.literal_or_identifier(self.first_arg_value(node)) {
                Some(n) if !n.is_empty() => n.to_string(),
                _ => return false,
            };
            let mut impl_node: Option<Node<'t>> = None;
            if let Some(args) = node.child_by_field_name("arguments") {
                let mut cursor = args.walk();
                for a in args.named_children(&mut cursor) {
                    if a.kind() != "argument" {
                        continue;
                    }
                    if let Some(v) = a.child_by_field_name("value") {
                        if v.kind() == "function_definition" {
                            impl_node = Some(v);
                            break;
                        }
                    }
                }
            }
            let params_text = impl_node
                .and_then(|i| i.child_by_field_name("parameters"))
                .map(|p| self.text(p));
            let fn_row = self.create_node("function", &name, node, params_text);
            let body = impl_node.and_then(|i| i.child_by_field_name("body"));
            if let (Some(row), Some(body)) = (fn_row, body) {
                self.with_scope(row, "function", name, |walker| walker.visit(body));
            }
            return true;
        }

        false // ordinary call — generic extraction records the edge
    }

    fn hook_binary_operator(&mut self, node: Node<'t>) -> bool {
        let op = match node.child_by_field_name("operator") {
            Some(o) => self.text(o),
            None => return false,
        };
        let lhs = node.child_by_field_name("lhs");
        let rhs = node.child_by_field_name("rhs");

        // name <- function(…) — ANY scope (r.ts:267-279). Body walked through
        // the hook-aware visit (visitFunctionBody never runs for R).
        if is_assign_left(op) {
            if let (Some(lhs), Some(rhs)) = (lhs, rhs) {
                if lhs.kind() == "identifier" && rhs.kind() == "function_definition" {
                    let params_text = rhs.child_by_field_name("parameters").map(|p| self.text(p));
                    let name = self.text(lhs).to_string();
                    let fn_row = self.create_node("function", &name, node, params_text);
                    let body = rhs.child_by_field_name("body");
                    if let (Some(row), Some(body)) = (fn_row, body) {
                        self.with_scope(row, "function", name, |walker| walker.visit(body));
                    }
                    return true;
                }
            }
        }

        let top_level = node
            .parent()
            .map(|p| p.kind() == "program")
            .unwrap_or(false);

        // Top-level value assignments → variable/constant (r.ts:284-296);
        // the class-definition idiom suppresses the twin variable node but the
        // rhs is ALWAYS visited.
        if top_level && is_assign_left(op) {
            if let (Some(lhs), Some(rhs)) = (lhs, rhs) {
                if lhs.kind() == "identifier" {
                    let rhs_callee = if rhs.kind() == "call" {
                        self.callee_name(rhs)
                    } else {
                        None
                    };
                    let suppressed = rhs_callee
                        .map(|c| is_class_fn(c) || is_generic_fn(c))
                        .unwrap_or(false);
                    if !suppressed {
                        let name = self.text(lhs);
                        let kind = if constant_name_re().is_match(name) {
                            "constant"
                        } else {
                            "variable"
                        };
                        self.create_node(kind, name, node, None);
                    }
                    self.visit(rhs);
                    return true;
                }
            }
        }

        // value -> name / value ->> name (r.ts:298-303).
        if top_level && is_assign_right(op) {
            if let (Some(lhs), Some(rhs)) = (lhs, rhs) {
                if rhs.kind() == "identifier" {
                    let name = self.text(rhs);
                    let kind = if constant_name_re().is_match(name) {
                        "constant"
                    } else {
                        "variable"
                    };
                    self.create_node(kind, name, node, None);
                    self.visit(lhs);
                    return true;
                }
            }
        }

        false
    }

    /// extractClassMembers (r.ts:110-163): arguments in source order with a
    /// positional counter — ggproto's 2nd positional identifier and
    /// `inherit`/`contains` named args become `extends` refs (from the CLASS
    /// row, positioned at the VALUE node); named function_definition args and
    /// `list(…)` entries become methods. Non-method argument subtrees are
    /// NEVER visited (`representation(…)`, `signature(…)` invisible).
    fn extract_class_members(&mut self, class_call: Node<'t>, class_row: u32) {
        let args = match class_call.child_by_field_name("arguments") {
            Some(a) => a,
            None => return,
        };
        let mut positional = 0u32;
        let mut cursor = args.walk();
        let arg_nodes: Vec<Node<'t>> = args.named_children(&mut cursor).collect();
        for arg in arg_nodes {
            if arg.kind() != "argument" {
                continue;
            }
            let arg_name = arg.child_by_field_name("name");
            let value = arg.child_by_field_name("value");
            let arg_name = match arg_name {
                None => {
                    positional += 1;
                    if positional == 2 {
                        if let Some(v) = value {
                            if v.kind() == "identifier" {
                                let parent = self.text(v).to_string();
                                self.push_ref_at(class_row, &parent, "extends", v);
                            }
                        }
                    }
                    continue;
                }
                Some(n) => n,
            };
            let arg_name_text = self.text(arg_name);
            // R6 `inherit = Parent` / S4 `contains = "Parent"` — a falsy
            // resolution (`inherit = pkg::Parent`, empty string) emits nothing.
            if arg_name_text == "inherit" || arg_name_text == "contains" {
                if let Some(value) = value {
                    if let Some(parent) = self.literal_or_identifier(Some(value)) {
                        if !parent.is_empty() {
                            let parent = parent.to_string();
                            self.push_ref_at(class_row, &parent, "extends", value);
                        }
                    }
                }
                continue;
            }
            // Direct named function argument (ggproto methods).
            if let Some(v) = value {
                if v.kind() == "function_definition" {
                    self.emit_method_arg(arg);
                    continue;
                }
                // list(…) of named function arguments (R5/R6 methods).
                if v.kind() == "call" && self.callee_name(v) == Some("list") {
                    if let Some(list_args) = v.child_by_field_name("arguments") {
                        let mut lc = list_args.walk();
                        let entries: Vec<Node<'t>> = list_args.named_children(&mut lc).collect();
                        for entry in entries {
                            if entry.kind() == "argument" {
                                self.emit_method_arg(entry);
                            }
                        }
                    }
                }
            }
        }
    }

    /// emitMethodArg (r.ts:84-98): `name = function(…)` argument entry → a
    /// `method` node positioned at the ARGUMENT node, signature from the raw
    /// parameters text, body walked hook-aware inside the method scope.
    fn emit_method_arg(&mut self, entry: Node<'t>) {
        let entry_name = match entry.child_by_field_name("name") {
            Some(n) => n,
            None => return,
        };
        let entry_value = match entry.child_by_field_name("value") {
            Some(v) if v.kind() == "function_definition" => v,
            _ => return,
        };
        let params_text = entry_value
            .child_by_field_name("parameters")
            .map(|p| self.text(p));
        let name = self.text(entry_name).to_string();
        let method_row = self.create_node("method", &name, entry, params_text);
        let body = entry_value.child_by_field_name("body");
        if let (Some(row), Some(body)) = (method_row, body) {
            self.with_scope(row, "method", name, |walker| walker.visit(body));
        }
    }

    // --- extractCall (tree-sitter.ts:3684, 4313, 4518-4532, 4572-4580) ----
    // R call nodes reach the generic tail: callee = RAW `function`-field text
    // verbatim (member branch unreachable, cpp recoveries language-gated),
    // then the parenthesized-conversion regex. No skipChildren — inner calls
    // are visited by the ladder's recursion afterward.

    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let func = match func {
            Some(f) => f,
            None => return,
        };
        let callee = util::normalize_parenthesized_name(self.text(func));
        if callee.is_empty() {
            return;
        }
        self.push_ref_at(caller_row, &callee, "calls", node);
    }
}
