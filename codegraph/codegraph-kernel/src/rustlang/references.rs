//! references for the rustlang extractor.

use super::*;

impl<'t> Walker<'t> {
    /// extractImport via the rust hook: import node named by the ROOT module +
    /// one generic root `imports` ref + per-binding FULL-path refs.
    /// `use x::*;` (use_wildcard) → hook returns null → nothing at all.
    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let use_arg = util::named_children(node).find(|c| {
            matches!(
                c.kind(),
                "scoped_use_list" | "scoped_identifier" | "use_list" | "identifier"
            )
        });
        let Some(use_arg) = use_arg else { return };

        let module_name = self.root_module(use_arg);
        let signature = self.text(node).trim().to_string();
        self.create_node(
            "import",
            &module_name.clone(),
            node,
            Extra {
                signature: Some(signature),
                ..Extra::default()
            },
        );
        let parent = self.top_row();
        let imports_kind = edge_kind_index("imports").unwrap();
        if !module_name.is_empty() {
            self.push_ref_at(parent, &module_name, imports_kind, node);
        }
        self.emit_use_binding_refs(node, parent);
    }

    /// extractCall — the rust paths of the generic else-branch (4312+).
    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let func = util::child_by_fields(node, &["function"], 0);
        let mut callee_name = String::new();

        if let Some(func) = func {
            if func.kind() == "field_expression" {
                let property = util::child_by_fields(func, &["property", "field"], 1);
                if let Some(property) = property {
                    let method_name = self.text(property);
                    let receiver =
                        util::child_by_fields(func, &["object", "operand", "argument"], 0);
                    if let Some(r) = receiver {
                        if is_literal_receiver(r.kind()) {
                            return; // emit NOTHING (#1230)
                        }
                    }
                    if let Some(r) = receiver {
                        match r.kind() {
                            // rust `self` is node kind `self`, NOT `identifier` —
                            // it dodges this branch and falls to the bare-name
                            // fallthrough (same net effect as SKIP_RECEIVERS).
                            "identifier" | "simple_identifier" | "field_identifier" => {
                                let receiver_name = self.text(r);
                                if !matches!(receiver_name, "self" | "this" | "cls" | "super") {
                                    callee_name = format!("{receiver_name}.{method_name}");
                                } else {
                                    callee_name = method_name.to_string();
                                }
                            }
                            "call_expression" => {
                                // Chained-call re-encode: ONLY an associated-
                                // function chain (`Foo::new().bar()`, inner
                                // callee a scoped_identifier). Instance chains
                                // keep the bare method name.
                                let inner_fn = r.child_by_field_name("function");
                                let reencode = inner_fn
                                    .map(|f| f.kind() == "scoped_identifier")
                                    .unwrap_or(false);
                                if reencode {
                                    let inner = util::strip_js_whitespace(
                                        &self.text(inner_fn.unwrap()).replace("->", "."),
                                    );
                                    callee_name = format!("{inner}().{method_name}");
                                } else {
                                    callee_name = method_name.to_string();
                                }
                            }
                            _ => {
                                // field_expression 2-hop, parenthesized,
                                // await_expression, `self` — bare method name.
                                callee_name = method_name.to_string();
                            }
                        }
                    } else {
                        callee_name = method_name.to_string();
                    }
                }
            } else if matches!(func.kind(), "scoped_identifier" | "scoped_call_expression") {
                callee_name = self.text(func).to_string();
            } else {
                // identifier; generic_function keeps the raw turbofish text
                // (`helper::<T>` — unresolvable downstream, preserved).
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            // Parenthesized-callee normalization — `(f)(x)` → `f`.
            callee_name = util::normalize_parenthesized_name(&callee_name);
            let from = self.top_row();
            self.push_ref_at(
                from,
                &callee_name.clone(),
                edge_kind_index("calls").unwrap(),
                node,
            );
        }
    }

    /// extractInstantiation — struct_expression via the GENERIC path: strip
    /// from the first `<`, keep the trailing `::`/`.` segment (JS slice
    /// semantics: slice(lastDot+1) after a `::` leaves one `:`, then ONE
    /// leading `[:.]` is stripped).
    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let ctor = util::child_by_fields(node, &["constructor", "type", "name"], 0);
        let Some(ctor) = ctor else { return };

        let class_name = util::strip_generic_and_qualifier(self.text(ctor));

        if !class_name.is_empty() {
            let from = self.top_row();
            self.push_ref_at(
                from,
                &class_name,
                edge_kind_index("instantiates").unwrap(),
                node,
            );
        }
    }

    /// extractInheritance — the rust-reachable cases: trait_bounds
    /// (supertraits; a scoped `fmt::Debug` bound matches NO case and is
    /// dropped), the Go embedding check on field_declaration (inert in rust —
    /// every field has a field_identifier), and the field_declaration_list
    /// recursion that reaches it.
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for child in util::named_children(node) {
            match child.kind() {
                "trait_bounds" => {
                    for bound in util::named_children(child) {
                        self.emit_inheritance_ref(
                            class_row,
                            extends_kind,
                            rust_trait_bound_type(bound),
                        );
                    }
                }
                "field_declaration" => {
                    let has_field_identifier =
                        util::has_named_child_kind(child, "field_identifier");
                    if !has_field_identifier {
                        self.emit_inheritance_ref(
                            class_row,
                            extends_kind,
                            util::first_named_child_kind(child, "type_identifier"),
                        );
                    }
                }
                "field_declaration_list" | "class_heritage" => {
                    self.extract_inheritance(child, class_row);
                }
                _ => {}
            }
        }
    }

    pub(super) fn emit_inheritance_ref(
        &mut self,
        class_row: u32,
        extends_kind: u8,
        type_node: Option<Node<'t>>,
    ) {
        if let Some(type_node) = type_node {
            let name = self.text(type_node).to_string();
            self.push_ref_at(class_row, &name, extends_kind, type_node);
        }
    }

    /// extractTypeAnnotations — parameters + return_type subtrees, one
    /// `references` ref per type_identifier leaf not in BUILTIN_TYPES. The
    /// trailing `type_annotation` child lookup is included for fidelity (the
    /// rust grammar has no such node — always a no-op).
    pub(super) fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if let Some(params) = node.child_by_field_name("parameters") {
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("return_type") {
            self.extract_type_refs_from_subtree(ret, from_row);
        }
        let type_annotation = util::first_named_child_kind(node, "type_annotation");
        if let Some(ta) = type_annotation {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    pub(super) fn extract_type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        util::emit_type_identifier_refs(&mut self.state, node, from_row, is_builtin_type);
    }
}
