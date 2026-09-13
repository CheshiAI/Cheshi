//! declarations for the php extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn extract_object_creation(&mut self, node: Node<'t>) -> bool {
        self.extract_instantiation(node);
        let Some(body) = find_anonymous_class_body(node) else {
            return false;
        };
        self.extract_anonymous_class(node, body);
        true
    }

    // --- extractors ----------------------------------------------------------------

    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        self.extract_callable(node, "function", true);
    }

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        self.extract_callable(node, "method", false);
    }

    pub(super) fn extract_callable(
        &mut self,
        node: Node<'t>,
        kind: &'static str,
        allow_anonymous: bool,
    ) {
        let name = self.extract_name(node);
        if allow_anonymous && name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None, // no getSignature hook
            visibility: Some(self.visibility_of(node)),
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node(kind, &name, node, extra) else {
            return;
        };
        self.extract_php_type_refs(node, row);
        // decorators: none.
        let body = node.child_by_field_name("body");
        self.with_scope(row, kind, name, |walker| {
            // Bodiless (interface/abstract) methods still mint nodes, no walk.
            if let Some(body) = body {
                walker.visit_function_body(body);
            }
        });
    }

    pub(super) fn extract_class(&mut self, node: Node<'t>, kind: &'static str) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node(kind, &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        // primary-ctor refs: csharp-only (needs a parameter_list child type);
        // decorators: none.
        self.visit_scoped_body(node, row, kind, name);
    }

    pub(super) fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default() // NO visibility — extractInterface never asks
        };
        let Some(row) = self.create_node("interface", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.visit_scoped_body(node, row, "interface", name);
    }

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else {
            return;
        };
        // class_interface_clause → implements refs; the backing type is never
        // read (it's not in a base_clause).
        self.extract_inheritance(node, row);
        self.stack.push(Scope {
            row,
            kind: "enum",
            name,
        });
        for child in util::named_children(body) {
            if child.kind() == "enum_case" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        // name-field path: one enum_member at the enum_case; backed values
        // (`= 'H'`) never walked.
        if let Some(name) = node
            .child_by_field_name("name")
            .map(|name_node| self.text(name_node).to_string())
        {
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    /// extractField — the php property_element branch (2077-2104): one `field`
    /// node per element, `$` re-added in the signature only, then RETURN — no
    /// decorators, no type-annotation refs from fields.
    pub(super) fn extract_field(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let visibility = Some(self.visibility_of(node));
        let is_static = Some(self.is_static(node));

        let prop_elements: Vec<Node> = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .filter(|c| c.kind() == "property_element")
            .collect();
        if prop_elements.is_empty() {
            // The declarator/bare fallbacks find nothing on php shapes.
            return;
        }
        // The type node: first namedChild that isn't a modifier or element.
        // QUIRK: final_modifier/abstract_modifier are NOT excluded — a
        // `final public Foo $x` takes `final` as the type text. PRESERVE.
        let type_node = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| {
                !matches!(
                    c.kind(),
                    "visibility_modifier"
                        | "static_modifier"
                        | "readonly_modifier"
                        | "property_element"
                        | "var_modifier"
                )
            });
        let type_text = type_node.map(|t| self.text(t).to_string());

        for elem in prop_elements {
            let var_name = (0..elem.named_child_count())
                .filter_map(|i| elem.named_child(i))
                .find(|c| c.kind() == "variable_name");
            let Some(var_name) = var_name else { continue };
            let name_node = (0..var_name.named_child_count())
                .filter_map(|i| var_name.named_child(i))
                .find(|c| c.kind() == "name");
            let Some(name_node) = name_node else { continue };
            let name = self.text(name_node).to_string();
            let signature = match &type_text {
                Some(t) => format!("{t} ${name}"),
                None => format!("${name}"),
            };
            self.create_node(
                "field",
                &name,
                elem,
                Extra {
                    docstring: docstring.clone(),
                    signature: Some(signature),
                    visibility,
                    is_static,
                    ..Extra::default()
                },
            );
        }
    }

    /// extractAnonymousClass — unreachable on v0.24.2 (the declaration_list
    /// nests inside `anonymous_class`, so findAnonymousClassBody finds no
    /// DIRECT child) — mirrored from the shared TS path for shape.
    pub(super) fn extract_anonymous_class(&mut self, node: Node<'t>, body: Node<'t>) {
        let type_node = php_constructor_node(node);
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
        let (line, column) = match type_node {
            Some(t) => (
                t.start_position().row as u32,
                util::node_column(self.src, &self.line_starts, t),
            ),
            None => (
                node.start_position().row as u32,
                util::node_column(self.src, &self.line_starts, node),
            ),
        };
        self.push_ref(
            row,
            &type_name,
            edge_kind_index("extends").unwrap(),
            line,
            column,
        );
        self.with_scope(row, "class", anon_name, |walker| {
            for child in util::named_children(body) {
                walker.visit_node(child);
            }
        });
    }
}
