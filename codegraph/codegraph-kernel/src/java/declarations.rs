//! declarations for the java extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractors --------------------------------------------------------------

    pub(super) fn extract_class(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.state.src),
            visibility: self.visibility_of(node),
            ..Extra::default() // java has no isExported hook
        };
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.extract_decorators_for(node, row);

        util::push_scope(&mut self.state.stack, row, "class", name);
        let body = node.child_by_field_name("body").unwrap_or(node);
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        // Lombok member synthesis (#912) — class still on the stack.
        self.synthesize_lombok_members(node, row);
        self.state.stack.pop();
    }

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        if !self.inside_class_like() {
            // (object-literal parents don't exist in Java; a stray top-level
            // method extracts as a function, mirroring extractMethod's tail)
            self.extract_function(node);
            return;
        }
        let name = self.extract_name(node);
        let extra = self.callable_extra(node);
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.visit_callable_body(row, "method", name, node);
    }

    /// extractFunction — only reachable for a method outside any class.
    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = self.callable_extra(node);
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.visit_callable_body(row, "function", name, node);
    }

    pub(super) fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.state.src),
            ..Extra::default()
        };
        let Some(row) = self.create_node("interface", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        util::push_scope(&mut self.state.stack, row, "interface", name);
        let body = node.child_by_field_name("body").unwrap_or(node);
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        self.state.stack.pop();
    }

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.state.src),
            visibility: self.visibility_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        util::push_scope(&mut self.state.stack, row, "enum", name);
        for child in util::named_children(body) {
            if child.kind() == "enum_constant" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.state.stack.pop();
    }

    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name) = util::declaration_name(node, self.state.src) {
            self.create_node("enum_member", &name, node, Extra::default());
        }
        // (identifier-children / leaf fallbacks are other grammars' shapes)
    }

    /// extractField — each declarator becomes a field/constant node.
    pub(super) fn extract_field(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.state.src);
        let visibility = self.visibility_of(node);
        let is_static = Some(self.is_static(node));
        let field_kind: &'static str = if self.is_const(node) {
            "constant"
        } else {
            "field"
        };

        let declarators: Vec<Node> = util::named_children(node)
            .filter(|c| c.kind() == "variable_declarator")
            .collect();

        if !declarators.is_empty() {
            let type_node = util::named_children(node).find(|c| {
                !matches!(
                    c.kind(),
                    "modifiers"
                        | "modifier"
                        | "variable_declarator"
                        | "variable_declaration"
                        | "marker_annotation"
                        | "annotation"
                )
            });
            let type_text = type_node.map(|t| self.text(t).to_string());

            for decl in declarators {
                let name_node = self.declaration_name_node(decl);
                let Some(name_node) = name_node else { continue };
                let name = self.text(name_node).to_string();
                let signature = match &type_text {
                    Some(t) => format!("{t} {name}"),
                    None => name.clone(),
                };
                let row = self.create_node(
                    field_kind,
                    &name,
                    decl,
                    Extra {
                        docstring: docstring.clone(),
                        signature: Some(signature),
                        visibility,
                        is_static,
                        ..Extra::default()
                    },
                );
                if let Some(row) = row {
                    self.extract_decorators_for(node, row);
                    self.extract_type_annotations(node, row);
                }
            }
        } else {
            let name_node = self.declaration_name_node(node);
            if let Some(name_node) = name_node {
                let name = self.text(name_node).to_string();
                self.create_node(
                    field_kind,
                    &name,
                    node,
                    Extra {
                        docstring,
                        visibility,
                        is_static,
                        ..Extra::default()
                    },
                );
            }
        }
    }

    /// extractVariable's generic fallback (top-level locals — rare in Java).
    pub(super) fn extract_variable(&mut self, node: Node<'t>) {
        let kind: &'static str = if self.is_const(node) {
            "constant"
        } else {
            "variable"
        };
        let docstring = preceding_docstring(node, self.state.src);
        for child in util::named_children(node) {
            let name = match child.kind() {
                "identifier" => self.text(child).to_string(),
                "variable_declarator" => self.extract_name(child),
                _ => continue,
            };
            if name.is_empty() || name == "<anonymous>" {
                continue;
            }
            self.create_node(
                kind,
                &name,
                child,
                Extra {
                    docstring: docstring.clone(),
                    ..Extra::default()
                },
            );
        }
    }

    /// extractAnonymousClass — `new T() { ... }`.
    pub(super) fn extract_anonymous_class(&mut self, node: Node<'t>, body: Node<'t>) {
        let type_node = self.constructor_node(node);
        let mut type_name = type_node
            .map(|t| self.text(t).to_string())
            .unwrap_or_else(|| "Object".to_string());
        type_name = util::strip_generic_and_qualifier(&type_name);
        if type_name.is_empty() {
            type_name = "Object".to_string();
        }

        let anon_name = format!("<{type_name}$anon@{}>", node.start_position().row + 1);
        let Some(row) = self.create_node("class", &anon_name, node, Extra::default()) else {
            return;
        };
        // Bug-for-bug: the TS code uses `startPosition.row` (0-based) as the
        // LINE here — the one place it forgets the +1.
        let (line, column) = match type_node {
            Some(t) => (t.start_position().row as u32, self.col_of(t)),
            None => (node.start_position().row as u32, self.col_of(node)),
        };
        self.push_ref(
            row,
            &type_name,
            edge_kind_index("extends").unwrap(),
            line,
            column,
        );

        util::push_scope(&mut self.state.stack, row, "class", anon_name);
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        self.state.stack.pop();
    }
}
