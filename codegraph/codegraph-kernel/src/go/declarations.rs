//! declarations for the go extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractors --------------------------------------------------------------

    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        // (getReceiverType only matches method_declaration's receiver field —
        // function_declaration has none, so no reroute happens here)
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.state.src),
            signature: self.signature_of(node),
            is_exported: Some(self.is_exported(node)),
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };
        self.extract_type_annotations(node, row);
        util::push_scope(&mut self.state.stack, row, "function", name);
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.state.stack.pop();
    }

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        // methodsAreTopLevel: always a method. Receiver-qualified name +
        // a contains edge from the FIRST earlier struct/class/enum/trait
        // node of the receiver's name (mirrors the this.nodes.find scan).
        let receiver_type = self.receiver_type_of(node);
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.state.src),
            signature: self.signature_of(node),
            return_type: self.return_type_of(node),
            qualified_name: receiver_type.as_ref().map(|r| format!("{r}::{name}")),
            ..Extra::default() // extractMethod passes no isExported
        };
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };

        if let Some(receiver_type) = &receiver_type {
            if !self.inside_class_like() {
                let owner_row = self
                    .nodes_meta
                    .iter()
                    .position(|m| {
                        m.name == *receiver_type
                            && matches!(m.kind, "struct" | "class" | "enum" | "trait")
                    })
                    .map(|i| i as u32);
                if let Some(owner_row) = owner_row {
                    util::emit_contains_edge(&mut self.state.tables, owner_row, row);
                }
            }
        }

        self.extract_type_annotations(node, row);
        util::push_scope(&mut self.state.stack, row, "method", name);
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.state.stack.pop();
    }

    /// extractTypeAlias for Go: type_spec → struct / interface / plain alias.
    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring(node, self.state.src);
        let is_exported = Some(self.is_exported(node));
        let type_child = node.child_by_field_name("type");
        let resolved = type_child.map(|t| t.kind());

        if resolved == Some("struct_type") {
            let Some(row) = self.create_node(
                "struct",
                &name,
                node,
                Extra {
                    docstring,
                    is_exported,
                    ..Extra::default()
                },
            ) else {
                return true;
            };
            util::push_scope(&mut self.state.stack, row, "struct", name);
            if let Some(type_child) = type_child {
                // Struct embedding → extends (field_declaration without a
                // field_identifier), reached via the inheritance recursion.
                self.extract_inheritance(type_child, row);
                let body = type_child.child_by_field_name("body").unwrap_or(type_child);
                for i in 0..body.named_child_count() {
                    if let Some(c) = body.named_child(i) {
                        self.visit_node(c);
                    }
                }
            }
            self.state.stack.pop();
            return true;
        }

        if resolved == Some("interface_type") {
            let Some(row) = self.create_node(
                "interface",
                &name,
                node,
                Extra {
                    docstring,
                    is_exported,
                    ..Extra::default()
                },
            ) else {
                return true;
            };
            if let Some(type_child) = type_child {
                self.extract_inheritance(type_child, row);
                self.extract_go_interface_methods(type_child, row, &name);
            }
            return true;
        }

        self.create_node(
            "type_alias",
            &name,
            node,
            Extra {
                docstring,
                is_exported,
                ..Extra::default()
            },
        );
        // (go type_spec has no `value` field — no type-ref walk; TS/tsx member
        // extraction is TS-family-only)
        false
    }

    /// extractVariable's Go branch: var/const specs + short_var_declaration.
    pub(super) fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.state.src);
        let is_const_decl = node.kind() == "const_declaration";

        for i in 0..node.named_child_count() {
            let Some(spec) = node.named_child(i) else {
                continue;
            };
            if !matches!(spec.kind(), "var_spec" | "const_spec") {
                continue;
            }
            let mut var_row: Option<u32> = None;
            if let Some(name_node) = spec.named_child(0) {
                if name_node.kind() == "identifier" {
                    let name = self.text(name_node).to_string();
                    let value_node = if spec.named_child_count() > 1 {
                        spec.named_child(spec.named_child_count() - 1)
                    } else {
                        None
                    };
                    let signature = value_node.map(|v| util::init_signature(self.text(v)));
                    var_row = self.create_node(
                        if is_const_decl {
                            "constant"
                        } else {
                            "variable"
                        },
                        &name,
                        spec,
                        Extra {
                            docstring: docstring.clone(),
                            signature,
                            ..Extra::default()
                        },
                    );
                }
            }
            // Walk the initializer ATTRIBUTED to the declared symbol (#693).
            if let Some(value_field) = spec.child_by_field_name("value") {
                if let Some(row) = var_row {
                    let name = self.nodes_meta[row as usize].name.clone();
                    util::push_scope(&mut self.state.stack, row, "variable", name);
                    self.visit_function_body(value_field);
                    self.state.stack.pop();
                } else {
                    self.visit_function_body(value_field);
                }
            }
        }

        if node.kind() == "short_var_declaration" {
            let left = node.child_by_field_name("left");
            let right = node.child_by_field_name("right");
            if let Some(left) = left {
                let identifiers: Vec<Node> = if left.kind() == "expression_list" {
                    (0..left.named_child_count())
                        .filter_map(|i| left.named_child(i))
                        .filter(|c| c.kind() == "identifier")
                        .collect()
                } else {
                    vec![left]
                };
                for id in identifiers {
                    let name = self.text(id).to_string();
                    let signature = right.map(|r| util::init_signature(self.text(r)));
                    self.create_node(
                        "variable",
                        &name,
                        node,
                        Extra {
                            docstring: docstring.clone(),
                            signature,
                            ..Extra::default()
                        },
                    );
                }
            }
        }
    }
}
