//! Lua + Luau extraction — a faithful Rust port of the lua/luau paths of
//! `TreeSitterExtractor` (src/extraction/tree-sitter.ts) plus
//! languages/lua.ts and languages/luau.ts (36 lines extending lua).
//!
//! One walker, two dialects (ccpp precedent): the differences are exactly
//! four — luau's typeAliasTypes=['type_definition'], the `export `-slice
//! isExported hook, the return-type signature suffix, and the grammar handle.
//! Load-bearing oddities preserved on purpose: the require/visitNode-hook
//! ASYMMETRIES (top-level requires — including inside top-level if/for/while
//! blocks — mint import nodes, while the identical statement in a function
//! body emits `calls "require"`; a top-level `local x = foo()` initializer
//! emits NO calls ref while a top-level global `x = foo()` does), the BFS
//! string-win inside require args (`require(script:WaitForChild("Kid"))` →
//! import "Kid"; `require("a".."b")` → import "a"), raw-text callees verbatim
//! (colon forms `M:render` with `self` never stripped, brackets `t2[k2]`,
//! newline-glued chains byte-verbatim, the `(handler)` paren-conversion),
//! receiver-QN methods (`M.sub.deep::chained`, stack-QN nested globals like
//! `render::leakedGlobal`), variable nodes positioned at the IDENTIFIER with
//! positional value pairing, LuaDoc `---` keeping a leading `- ` and
//! `--!strict` joining docstring chains, the lua↔luau isExported wire
//! divergence (lua functions: flag ABSENT; luau functions: present-false;
//! methods: absent in both; variables: present-false in both), and duplicate
//! same-(kind,name,line) ids emitted twice. Positions in UTF-16 code units.
//! Files with parse errors defer to wasm (lua ~0%; luau 1.4–7.1% both-arm).

use crate::buffers::EmitOut;
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use std::collections::VecDeque;
use std::ops::{Deref, DerefMut};
use tree_sitter::Node;

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    util::is_fn_ref_stoplisted(name)
}

type Scope = util::Scope;
type Extra = util::NodeExtra;

pub struct Walker<'t> {
    is_luau: bool,
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

pub fn extract(file_path: &str, source: &str, language: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for(language).ok_or("no lua/luau grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, language)?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        is_luau: language == "luau",
        state: util::WalkerState::new(file_path, source),
    };

    // File node (tree-sitter.ts:508-521).
    let base_name = util::emit_file_node(
        file_path,
        source,
        &mut w.state.arena,
        &mut w.state.tables,
        &mut w.state.node_ids,
    );
    w.stack.push(Scope {
        row: 0,
        kind: "file",
        name: base_name.to_string(),
    });

    // No packageTypes → no namespace node. Value-refs are language-gated off.
    w.visit(tree.root_node());
    w.flush_fn_ref_candidates();
    w.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

impl<'t> Walker<'t> {
    // --- createNode (tree-sitter.ts:1308) ---------------------------------

    fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        let row = util::emit_node_row(&mut self.state, kind, name, node, extra)?;
        if matches!(kind, "function" | "method") {
            self.state.defined_fn_names.insert(name.to_string());
        }
        Some(row)
    }

    // --- lua.ts helper transcriptions -------------------------------------

    /// findDescendant (lua.ts:9-17) — breadth-first over namedChildren.
    fn find_descendant(&self, node: Node<'t>, kind: &str) -> Option<Node<'t>> {
        let mut queue: VecDeque<Node<'t>> = util::named_children(node).collect();
        while let Some(n) = queue.pop_front() {
            if n.kind() == kind {
                return Some(n);
            }
            queue.extend(util::named_children(n));
        }
        None
    }

    /// requireModule (lua.ts:28-60).
    fn require_module(&self, call: Node<'t>) -> Option<String> {
        let name = call.child_by_field_name("name")?;
        if name.kind() != "identifier" || self.text(name) != "require" {
            return None;
        }
        let args = call.child_by_field_name("arguments")?;

        // String win: first string_content descendant, BFS order.
        if let Some(content) = self.find_descendant(args, "string_content") {
            let t = self.text(content).trim();
            return if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            };
        }
        // Fallback: a string node with no content child — strip [[ ]] / quotes.
        if let Some(s) = self.find_descendant(args, "string") {
            let mut t = self.text(s).trim();
            t = t.strip_prefix("[[").unwrap_or(t);
            t = t.strip_suffix("]]").unwrap_or(t);
            t = t.strip_prefix(['"', '\'']).unwrap_or(t);
            t = t.strip_suffix(['"', '\'']).unwrap_or(t);
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
        // Roblox instance path: trailing field/method segment.
        let idx = self
            .find_descendant(args, "dot_index_expression")
            .or_else(|| self.find_descendant(args, "method_index_expression"));
        if let Some(idx) = idx {
            if let Some(field) = idx
                .child_by_field_name("field")
                .or_else(|| idx.child_by_field_name("method"))
            {
                let t = self.text(field).trim();
                return if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                };
            }
        }
        None
    }

    /// The hook's `emit` (lua.ts:108-126): import node at the CALL node +
    /// imports ref from the stack top.
    fn emit_require(&mut self, call: Node<'t>, module: &str) {
        let (sig, _) = util::slice_utf16(self.text(call).trim(), 100);
        let imp = self.create_node(
            "import",
            module,
            call,
            Extra {
                signature: Some(sig),
                ..Default::default()
            },
        );
        if imp.is_some() && !self.stack.is_empty() {
            let parent_row = self.top_row();
            util::emit_state_ref_at(
                &mut self.state,
                parent_row,
                module,
                crate::buffers::edge_kind_index("imports").unwrap(),
                call,
            );
        }
    }

    /// getReceiverType (lua.ts:92-99).
    fn receiver_type(&self, node: Node<'t>) -> Option<&'t str> {
        let name = node.child_by_field_name("name")?;
        if name.kind() == "dot_index_expression" || name.kind() == "method_index_expression" {
            return name.child_by_field_name("table").map(|t| self.text(t));
        }
        None
    }

    /// extractName (tree-sitter.ts:98-192) — the lua-reachable branches.
    fn extract_name(&self, node: Node<'t>) -> String {
        if let Some(name_node) = node.child_by_field_name("name") {
            // Lua: dot/method index → the trailing field/method segment.
            if name_node.kind() == "dot_index_expression" {
                if let Some(f) = name_node.child_by_field_name("field") {
                    return self.text(f).to_string();
                }
            }
            if name_node.kind() == "method_index_expression" {
                if let Some(m) = name_node.child_by_field_name("method") {
                    return self.text(m).to_string();
                }
            }
            return self.text(name_node).to_string();
        }
        // Fallback: first identifier-ish named child.
        util::first_named_child_kind_any(
            node,
            &[
                "identifier",
                "type_identifier",
                "simple_identifier",
                "constant",
            ],
        )
        .map(|child| self.text(child).to_string())
        .unwrap_or_else(|| "<anonymous>".to_string())
    }

    /// getSignature — lua (lua.ts:83-86) / luau (luau.ts:26-35).
    fn signature_of(&self, node: Node<'t>) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if self.is_luau {
            // Return type = the named child AFTER `parameters` (found by
            // startIndex match), unless it's the block.
            let kids: Vec<Node<'t>> = util::named_children(node).collect();
            if let Some(idx) = kids
                .iter()
                .position(|k| k.start_byte() == params.start_byte())
            {
                if let Some(ret) = kids.get(idx + 1) {
                    if ret.kind() != "block" {
                        sig.push_str(": ");
                        sig.push_str(self.text(*ret));
                    }
                }
            }
        }
        Some(sig)
    }

    /// isExported (luau.ts:23) — the raw 7-unit slice is an ASCII prefix test.
    fn is_exported_of(&self, node: Node<'t>) -> Option<bool> {
        if self.is_luau {
            Some(self.text(node).starts_with("export "))
        } else {
            None
        }
    }

    // --- the main walk (visitNode, tree-sitter.ts:936-1303) ---------------

    fn visit(&mut self, node: Node<'t>) {
        let kind = node.kind();

        // The visitNode hook (lua.ts:105-151) runs FIRST.
        if kind == "function_call" {
            if let Some(module) = self.require_module(node) {
                self.emit_require(node, &module);
                // Consumed → scanFnRefSubtree (tree-sitter.ts:951).
                self.scan_fn_ref_subtree(node, 0);
                return;
            }
            // falls through — extractCall claims it below
        } else if kind == "variable_declaration" {
            // `local x = require(...)` — dig requires out of the initializer
            // the variable branch will skip. Always falls through.
            let mut cursor = node.walk();
            let assign = node
                .named_children(&mut cursor)
                .find(|c| c.kind() == "assignment_statement");
            if let Some(assign) = assign {
                let mut ac = assign.walk();
                let expr_list = assign
                    .named_children(&mut ac)
                    .find(|c| c.kind() == "expression_list");
                if let Some(expr_list) = expr_list {
                    let mut ec = expr_list.walk();
                    let vals: Vec<Node<'t>> = expr_list.named_children(&mut ec).collect();
                    for val in vals {
                        if val.kind() == "function_call" {
                            if let Some(module) = self.require_module(val) {
                                self.emit_require(val, &module);
                            }
                        }
                    }
                }
            }
        }

        // maybeCaptureFnRefs (tree-sitter.ts:990).
        self.maybe_capture_fn_refs(node);

        // The dispatch ladder — lua/luau rows only.
        if kind == "function_declaration" {
            // isInsideClassLikeNode is always false (no class-like kinds).
            self.extract_function(node);
            return; // skipChildren — the body walk handles children
        }
        if self.is_luau && kind == "type_definition" {
            let skip = self.extract_type_alias(node);
            if skip {
                return;
            }
            // plain path returns false → children re-visited (the
            // typeof(require(...)) alias+import pair rides this).
        } else if kind == "variable_declaration" {
            self.extract_variable(node);
            // Initializer subtrees are never walked — candidates only.
            self.scan_fn_ref_subtree(node, 0);
            return; // skipChildren
        } else if kind == "function_call" {
            self.extract_call(node);
            // no skipChildren — nested/inner calls each get their own ref
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
    }

    // --- extractFunction / extractMethod (1517 / 1737) --------------------

    fn extract_function(&mut self, node: Node<'t>) {
        // :1522 receiver short-circuit IS the method routing.
        if let Some(receiver) = self.receiver_type(node) {
            let receiver = receiver.to_string();
            self.extract_method(node, receiver);
            return;
        }
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            // Unreachable for function_declaration (grammar requires a name)
            // but preserved: body walked with nothing pushed.
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_body(body);
            }
            return;
        }
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        let is_exported = self.is_exported_of(node); // lua None / luau Some(false)
        let fn_row = self.create_node(
            "function",
            &name,
            node,
            Extra {
                docstring,
                signature,
                is_exported,
                ..Default::default()
            },
        );
        let Some(row) = fn_row else { return };
        // extractTypeAnnotations / extractDecoratorsFor: structurally zero
        // output for lua/luau (gates + no decorator kinds in scan positions).
        let body = node.child_by_field_name("body");
        self.with_scope(row, "function", name, |walker| {
            if let Some(body) = body {
                walker.visit_body(body);
            }
        });
    }

    fn extract_method(&mut self, node: Node<'t>, receiver: String) {
        let name = self.extract_name(node);
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        // extractMethod passes NO isExported — absent for BOTH dialects.
        // QN override (:1790-1792): `receiver::name` verbatim (namespacePrefix
        // is empty outside C++).
        let qn = format!("{receiver}::{name}");
        let method_row = self.create_node(
            "method",
            &name,
            node,
            Extra {
                docstring,
                signature,
                qualified_name: Some(qn),
                ..Default::default()
            },
        );
        let Some(row) = method_row else { return };
        // Owner-contains (:1799-1813) never fires: lua mints no
        // struct/class/enum/trait nodes for a receiver name to match.
        let body = node.child_by_field_name("body");
        self.with_scope(row, "method", name, |walker| {
            if let Some(body) = body {
                walker.visit_body(body);
            }
        });
    }

    // --- extractVariable — the lua/luau branch (2538-2549, 2789-2805) -----

    fn extract_variable(&mut self, node: Node<'t>) {
        // isConst absent → kind is ALWAYS `variable`; docstring from the
        // DECLARATION node; isExported = hook ?? false → false for BOTH
        // dialects (luau's slice sees `local …`).
        let docstring = preceding_docstring(node, self.src);
        let is_exported = self.is_exported_of(node).unwrap_or(false);

        let assign = util::named_children(node)
            .find(|c| c.kind() == "assignment_statement")
            .unwrap_or(node);
        let var_list = util::named_children(assign).find(|c| c.kind() == "variable_list");
        let expr_list = util::named_children(assign).find(|c| c.kind() == "expression_list");
        let values: Vec<Node<'t>> = match expr_list {
            Some(el) => util::named_children(el).collect(),
            None => Vec::new(),
        };
        let names: Vec<Node<'t>> = match var_list {
            Some(vl) => util::named_children(vl)
                .filter(|n| n.kind() == "identifier")
                .collect(),
            None => Vec::new(),
        };
        for (i, name_node) in names.iter().enumerate() {
            let name = self.text(*name_node);
            if name.is_empty() {
                continue;
            }
            // Positional value pairing; a missing value → NO signature key.
            let signature = values.get(i).map(|v| util::init_signature(self.text(*v)));
            let name = name.to_string();
            self.create_node(
                "variable",
                &name,
                *name_node, // positioned at the IDENTIFIER
                Extra {
                    docstring: docstring.clone(),
                    signature,
                    is_exported: Some(is_exported),
                    ..Default::default()
                },
            );
        }
    }

    // --- extractTypeAlias (2890; plain path 2967-2991) — luau only --------

    /// Returns skipChildren (always false on the plain path).
    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node); // generic_type name → verbatim text
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring(node, self.src);
        let is_exported = self.is_exported_of(node); // Some(true) for `export type`
        self.create_node(
            "type_alias",
            &name,
            node,
            Extra {
                docstring,
                is_exported,
                ..Default::default()
            },
        );
        // TYPE_ANNOTATION_LANGUAGES excludes luau → no alias-value refs.
        false // children re-visited by the ladder
    }

    // --- extractCall (3684; generic tail 4313, 4518-4532, 4572-4580) ------

    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        // The `function` field is NULL in this grammar → namedChild(0) (the
        // `name:` child). Member branch never fires (dot/method_index aren't
        // in its type list) → raw source text, then the paren-conversion.
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };
        let mut callee: &str = self.text(func);
        if let Some(caps) = util::paren_conversion().captures(callee) {
            if let Some(inner) = caps.get(1) {
                callee = &callee[inner.range()];
            }
        }
        if callee.is_empty() {
            return;
        }
        let callee = callee.to_string();
        util::emit_state_ref_at(
            &mut self.state,
            caller_row,
            &callee,
            crate::buffers::edge_kind_index("calls").unwrap(),
            node,
        );
    }

    // --- visitFunctionBody (5129-5286) — the hook-free body walk ----------

    fn visit_body(&mut self, node: Node<'t>) {
        // maybeCaptureFnRefs (5137) fires in the body walker too.
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        if kind == "function_call" {
            // The hook NEVER runs here — a body-level require emits
            // `calls "require"` (the neovim lazy-loading idiom).
            self.extract_call(node);
            // falls through to recursion — chains emit every link
        } else if kind == "function_declaration" {
            // Nested NAMED functions (5245-5250): extractFunction walks the
            // nested body itself, so return. extractName is never
            // `<anonymous>` for function_declaration.
            self.extract_function(node);
            return;
        }
        // variable_declaration / type_definition have NO branch here → plain
        // recursion: body-local initializers ARE walked (calls emit), no
        // variable/type_alias nodes minted.

        for child in util::named_children(node) {
            self.visit_body(child);
        }
    }

    // --- function-as-value capture (#756) — LUA_SPEC ----------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        // LUA_SPEC dispatch: arguments → args; assignment_statement → rhs
        // (no field — last named child; param-storage skip via namedChild(0));
        // field → value (field 'value', last-named-child fallback).
        let mode: &str = match node.kind() {
            "arguments" => "args",
            "assignment_statement" => "rhs",
            "field" => "value",
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
        match mode {
            "args" => {
                for c in util::named_children(node) {
                    values.push(c);
                }
            }
            "rhs" => {
                // No `field` in the rule → RHS = LAST named child (the
                // expression_list). Param-storage skip: lhs =
                // left/lhs/target field ?? namedChild(0) when ≥2 children;
                // its trailing identifier vs the whole RHS text.
                let count = node.named_child_count();
                let rhs = if count > 0 {
                    node.named_child(count - 1)
                } else {
                    None
                };
                if let Some(rhs) = rhs {
                    let lhs = node
                        .child_by_field_name("left")
                        .or_else(|| node.child_by_field_name("lhs"))
                        .or_else(|| node.child_by_field_name("target"))
                        .or_else(|| {
                            if count >= 2 {
                                node.named_child(0)
                            } else {
                                None
                            }
                        });
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    if !(lhs_last.is_some() && lhs_last == Some(self.text(rhs).trim())) {
                        values.push(rhs);
                    }
                }
            }
            _ => {
                // value — the `value` field (keyed AND positional table
                // fields carry it), falling back to the last named child.
                let v = node.child_by_field_name("value").or_else(|| {
                    let count = node.named_child_count();
                    if count > 0 {
                        node.named_child(count - 1)
                    } else {
                        None
                    }
                });
                if let Some(v) = v {
                    values.push(v);
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue with LUA_SPEC's one transparent layer (expression_list
    /// fans out to named children).
    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = self.text(v).to_string();
                if name.is_empty() || is_stoplisted(&name) {
                    return;
                }
                util::record_fn_ref_candidate(&mut self.state.fn_ref_cands, from, &name, v);
            }
            "expression_list" => {
                for c in util::named_children(v) {
                    self.normalize_fn_ref_value(c, from, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        // Halt at nested function definitions (their bodies are walked — and
        // attributed — by extractFunction). function_definition (anonymous)
        // is deliberately NOT in the halt list — the scan descends into
        // anonymous initializer bodies, attributing candidates to the file.
        util::walk_named_subtree(
            node,
            depth,
            12,
            &|candidate, candidate_depth| {
                candidate_depth > 0
                    && matches!(
                        candidate.kind(),
                        "function_declaration"
                            | "arrow_function"
                            | "function_expression"
                            | "lambda_literal"
                            | "lambda_expression"
                    )
            },
            &mut |candidate, _| self.maybe_capture_fn_refs(candidate),
        );
    }

    fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }
}
