//! Python extraction — a faithful Rust port of `TreeSitterExtractor`'s Python
//! paths (src/extraction/tree-sitter.ts) plus languages/python.ts.
//!
//! Same porting contract as tsjs/java: behavior parity, bug-for-bug —
//! including the quirks: decorates refs only fire for bare-identifier
//! decorators (`@staticmethod` yes, `@app.route(...)` no — python's `call`
//! kind isn't `call_expression`), module-level assignments always extract as
//! `variable` (no isConst hook), and `self.method` fn-ref candidates carry the
//! BARE attribute name. Python is not a TYPE_ANNOTATION language — no type
//! refs anywhere. Files with parse errors defer to wasm.

use crate::buffers::{edge_kind_index, EmitOut};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use std::ops::{Deref, DerefMut};
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

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
    let grammar = crate::langs::grammar_for("python").ok_or("no python grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "python")?;
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

    w.visit_node(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

impl<'t> Walker<'t> {
    fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
    }

    fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        let row = util::emit_node_row(&mut self.state, kind, name, node, extra)?;
        util::record_node_bookkeeping(
            &mut self.state,
            kind,
            name,
            node,
            row,
            matches!(kind, "function" | "method" | "class"),
        );
        Some(row)
    }

    fn extract_name(&self, node: Node) -> String {
        util::declaration_name(node, self.src).unwrap_or_else(|| "<anonymous>".to_string())
    }

    /// pythonExtractor.getSignature: params + ` -> returnType`.
    fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if let Some(ret) = node.child_by_field_name("return_type") {
            sig.push_str(" -> ");
            sig.push_str(self.text(ret));
        }
        Some(sig)
    }

    /// pythonExtractor.isAsync: the PREVIOUS SIBLING token is `async`.
    fn is_async(&self, node: Node) -> bool {
        node.prev_sibling()
            .map(|p| p.kind() == "async")
            .unwrap_or(false)
    }

    /// pythonExtractor.isStatic: preceding decorator mentioning `staticmethod`.
    fn is_static(&self, node: Node) -> bool {
        if let Some(prev) = node.prev_named_sibling() {
            if prev.kind() == "decorator" {
                return self.text(prev).contains("staticmethod");
            }
        }
        false
    }

    // --- visitNode ------------------------------------------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_definition" {
            // functionTypes ∩ methodTypes: inside a class-like ⇒ method.
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "class_definition" {
            self.extract_class(node);
            skip_children = true;
        } else if kind == "assignment" && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_statement" || kind == "import_from_statement" {
            self.extract_import(node);
        } else if kind == "call" {
            self.extract_call(node);
        }

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call" {
            self.extract_call(node);
        }

        // Nested NAMED functions become their own nodes.
        if kind == "function_definition" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_definition" {
            self.extract_class(node);
            return;
        }

        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }

    // --- extractors --------------------------------------------------------------

    fn extract_function(&mut self, node: Node<'t>) {
        self.extract_callable(node, "function", true);
    }

    fn extract_method(&mut self, node: Node<'t>) {
        self.extract_callable(node, "method", false);
    }

    fn extract_callable(&mut self, node: Node<'t>, kind: &'static str, visit_anonymous_body: bool) {
        let name = self.extract_name(node);
        if visit_anonymous_body && name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: self.signature_of(node),
            is_async: Some(self.is_async(node)),
            is_static: Some(self.is_static(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node(kind, &name, node, extra) else {
            return;
        };
        // (python is not a TYPE_ANNOTATION language — no type refs)
        self.extract_decorators_for(node, row);
        let body = node.child_by_field_name("body");
        self.with_scope(row, kind, name, |walker| {
            if let Some(body) = body {
                walker.visit_function_body(body);
            }
        });
    }

    fn extract_class(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };

        // Inheritance: `class Flask(Scaffold, Mixin):` — argument_list children.
        let extends_kind = edge_kind_index("extends").unwrap();
        for child in util::named_children(node) {
            if child.kind() == "argument_list" {
                for arg in util::named_children(child) {
                    if matches!(arg.kind(), "identifier" | "attribute") {
                        let name = self.text(arg).to_string();
                        self.push_ref_at(row, &name, extends_kind, arg);
                    }
                }
            }
        }
        self.extract_decorators_for(node, row);

        let body = node.child_by_field_name("body").unwrap_or(node);
        self.with_scope(row, "class", name, |walker| {
            for child in util::named_children(body) {
                walker.visit_node(child);
            }
        });
    }

    /// extractVariable's python branch: `left = right` at module scope.
    fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let left = node
            .child_by_field_name("left")
            .or_else(|| node.named_child(0));
        let right = node
            .child_by_field_name("right")
            .or_else(|| node.named_child(1));
        let Some(left) = left else { return };
        if !matches!(left.kind(), "identifier" | "constant") {
            return;
        }
        let name = self.text(left).to_string();
        let signature = right.map(|r| util::init_signature(self.text(r)));
        // No isConst hook ⇒ always `variable` (UPPER_CASE constants included).
        self.create_node(
            "variable",
            &name,
            node,
            Extra {
                docstring,
                signature,
                ..Extra::default()
            },
        );
    }

    fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let imports_kind = edge_kind_index("imports").unwrap();

        if node.kind() == "import_from_statement" {
            // Hook path: module_name field → import node + module ref, then
            // per-name binding refs (emitPyFromImportRefs).
            let Some(module_node) = node.child_by_field_name("module_name") else {
                return;
            };
            let module_name = self.text(module_node).to_string();
            if module_name.is_empty() {
                return;
            }
            self.create_node(
                "import",
                &module_name,
                node,
                Extra {
                    signature: Some(import_text),
                    ..Extra::default()
                },
            );
            let parent = self.top_row();
            self.push_ref_at(parent, &module_name.clone(), imports_kind, node);

            // emitPyFromImportRefs: one `imports` ref per imported name.
            for child in util::named_children(node) {
                if child.start_byte() == module_node.start_byte()
                    && child.end_byte() == module_node.end_byte()
                {
                    continue;
                }
                if child.kind() == "wildcard_import" {
                    continue;
                }
                let name_node = match child.kind() {
                    "aliased_import" => child
                        .child_by_field_name("alias")
                        .or_else(|| child.child_by_field_name("name"))
                        .or_else(|| child.named_child(0)),
                    "dotted_name" => Some(child),
                    _ => None,
                };
                let Some(name_node) = name_node else { continue };
                let raw = self.text(name_node);
                let local = raw.rsplit('.').next().unwrap_or("");
                if local.is_empty() {
                    continue;
                }
                self.push_ref_at(parent, local, imports_kind, name_node);
            }
            return;
        }

        // import_statement: `import a.b, x as y` — one import node + module ref
        // per dotted name (the python multi-import branch).
        let parent = self.top_row();
        for child in util::named_children(node) {
            if child.kind() == "dotted_name" {
                let name = self.text(child).to_string();
                self.create_node(
                    "import",
                    &name,
                    node,
                    Extra {
                        signature: Some(import_text.clone()),
                        ..Extra::default()
                    },
                );
                self.push_ref_at(parent, &name, imports_kind, child);
            } else if child.kind() == "aliased_import" {
                let dotted = util::named_children(child).find(|c| c.kind() == "dotted_name");
                if let Some(dotted) = dotted {
                    let name = self.text(dotted).to_string();
                    self.create_node(
                        "import",
                        &name,
                        node,
                        Extra {
                            signature: Some(import_text.clone()),
                            ..Extra::default()
                        },
                    );
                    self.push_ref_at(parent, &name, imports_kind, dotted);
                }
            }
        }
    }

    /// extractCall — python `call` through the generic tail (attribute callees).
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let mut callee_name = String::new();

        if let Some(func) = func {
            if func.kind() == "attribute" {
                // `property` and `field` fields don't exist on attribute —
                // the generic path falls back to namedChild(1) (the attr name).
                let property = util::child_by_fields(func, &["property", "field"], 1);
                if let Some(property) = property {
                    let method_name = self.text(property);
                    let receiver =
                        util::child_by_fields(func, &["object", "operand", "argument"], 0);
                    if let Some(r) = receiver {
                        if is_literal_receiver(r.kind()) {
                            return;
                        }
                    }
                    let recv_ident = receiver.filter(|r| {
                        matches!(
                            r.kind(),
                            "identifier" | "simple_identifier" | "field_identifier"
                        )
                    });
                    if let Some(r) = recv_ident {
                        callee_name = util::compose_member_callee(Some(self.text(r)), method_name);
                    } else {
                        callee_name = util::compose_member_callee(None, method_name);
                    }
                }
            } else {
                callee_name = self.text(func).to_string();
            }
        }

        let from = self.top_row();
        util::emit_state_call_ref(&mut self.state, from, &callee_name, node);
    }

    /// extractDecoratorsFor — python decorators are PRECEDING SIBLINGS inside
    /// decorated_definition. Only bare-identifier decorators yield a target
    /// (python's `call` kind isn't `call_expression`, and `attribute` isn't in
    /// the target-kind list — mirrored exactly).
    fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for child in util::decorator_nodes(decl) {
            self.consider_decorator(child, decorated_row);
        }
    }

    fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        let Some(name) = util::decorator_name(n, self.src) else {
            return;
        };
        self.push_ref_at(
            decorated_row,
            &name,
            edge_kind_index("decorates").unwrap(),
            n,
        );
    }

    // --- fn refs (PYTHON_SPEC) ------------------------------------------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "argument_list" => ("args", ""),
            "assignment" => ("rhs", "right"),
            "keyword_argument" => ("value", "value"),
            "pair" => ("value", "value"),
            "list" => ("list", ""),
            // `return SomeClass` / `return handler` (#1478) — a single
            // returned expression is a direct named child ('list' shape);
            // tuple returns sit under expression_list and are not descended
            // (mirrors PYTHON_SPEC).
            "return_statement" => ("list", ""),
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            "args" | "list" => {
                values.extend(util::named_children(node));
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
                    if !util::is_param_storage_assignment_node(node, self.src, rhs) {
                        values.push(rhs);
                    }
                }
            }
            _ => {
                if let Some(v) = node.child_by_field_name(field) {
                    values.push(v);
                }
            }
        }

        for v in values {
            let (name, anchor) = match v.kind() {
                "identifier" => (self.text(v).to_string(), v),
                // `self.handle_click` — object EXACTLY `self`; BARE attr name.
                "attribute" => {
                    let obj = v.child_by_field_name("object");
                    let attr = v.child_by_field_name("attribute");
                    match (obj, attr) {
                        (Some(o), Some(a))
                            if o.kind() == "identifier" && self.text(o) == "self" =>
                        {
                            (self.text(a).to_string(), a)
                        }
                        _ => continue,
                    }
                }
                _ => continue,
            };
            util::record_fn_ref_candidate(&mut self.fn_ref_cands, from, &name, anchor);
        }
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        let stop = |node: Node, depth: u32| {
            depth > 0
                && matches!(
                    node.kind(),
                    "function_definition"
                        | "arrow_function"
                        | "function_expression"
                        | "lambda_literal"
                        | "lambda_expression"
                )
        };
        let mut visit = |node: Node<'t>, _depth: u32| self.maybe_capture_fn_refs(node);
        util::walk_named_subtree(node, depth, 12, &stop, &mut visit);
    }

    fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value refs -------------------------------------------------------------------

    fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if !crate::value_refs_enabled() {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune — python's declarator shape is `assignment`.
        let decl_counts =
            util::count_shadow_declarations_many(root, MAX_VALUE_REF_NODES, &targets, |node| {
                util::assignment_declared_names(node, self.src)
            });
        util::prune_shadowed_targets(&mut targets, &decl_counts, &counts);
        if targets.is_empty() {
            return;
        }

        let state = &mut self.state;
        util::emit_state_value_ref_edges(state, &scopes, &targets, MAX_VALUE_REF_NODES, &[]);
    }
}

/// LITERAL_RECEIVER_TYPES membership (shared table; python names among them).
fn is_literal_receiver(kind: &str) -> bool {
    util::is_literal_receiver_kind(kind)
}
