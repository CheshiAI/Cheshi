//! walker for the java extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref(
        &mut self,
        from_row: u32,
        name: &str,
        kind_code: u8,
        line: u32,
        column: u32,
    ) {
        util::emit_state_ref(&mut self.state, from_row, name, kind_code, line, column);
    }

    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
    }

    // --- createNode ------------------------------------------------------------

    pub(super) fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let qualified = util::join_qualified_name(
            self.state
                .stack
                .iter()
                .filter(|scope| scope.kind != "file")
                .map(|scope| scope.name.as_str()),
            name,
        );
        let row = util::emit_recorded_node_row(
            &mut self.state,
            kind,
            name,
            node,
            util::NodeExtra {
                docstring: extra.docstring,
                signature: extra.signature,
                qualified_name: Some(qualified.clone()),
                decorators: extra.decorators,
                visibility: extra.visibility,
                is_static: extra.is_static,
                return_type: extra.return_type,
                ..util::NodeExtra::default()
            },
            matches!(kind, "function" | "method"),
        )?;
        self.nodes_meta.push(NodeMeta {
            kind,
            name: name.to_string(),
            qualified_name: qualified,
        });
        Some(row)
    }

    // --- modifiers / hooks (languages/java.ts) -----------------------------------

    pub(super) fn modifiers_child(&self, node: Node<'t>) -> Option<Node<'t>> {
        util::first_named_child_kind(node, "modifiers")
    }

    pub(super) fn visibility_of(&self, node: Node) -> Option<u8> {
        for i in 0..node.child_count() {
            let child = node.child(i)?;
            if child.kind() == "modifiers" {
                let text = self.text(child);
                if text.contains("public") {
                    return Some(1);
                }
                if text.contains("private") {
                    return Some(2);
                }
                if text.contains("protected") {
                    return Some(3);
                }
            }
        }
        None
    }

    pub(super) fn is_static(&self, node: Node) -> bool {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.kind() == "modifiers" && self.text(child).contains("static") {
                    return true;
                }
            }
        }
        false
    }

    /// javaExtractor.isConst: `static final` field → constant.
    pub(super) fn is_const(&self, node: Node) -> bool {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.kind() == "modifiers" {
                    let text = self.text(child);
                    return word_re("static").is_match(text) && word_re("final").is_match(text);
                }
            }
        }
        false
    }

    pub(super) fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let params_text = self.text(params);
        match node.child_by_field_name("type") {
            Some(ret) => Some(format!("{} {}", self.text(ret), params_text)),
            None => Some(params_text.to_string()),
        }
    }

    /// normalizeJavaType (languages/java.ts).
    pub(super) fn normalize_java_type(&self, type_node: Option<Node>) -> Option<String> {
        let t = type_node?;
        if is_non_class_return(t.kind()) || t.kind() == "array_type" {
            return None;
        }
        let raw = generic_args_re()
            .replace_all(self.text(t).trim(), "")
            .into_owned();
        let last = raw.rsplit('.').next().unwrap_or("").trim().to_string();
        if last.is_empty() || !simple_ident_re().is_match(&last) {
            return None;
        }
        Some(last)
    }

    pub(super) fn extract_name(&self, node: Node) -> String {
        util::declaration_name(node, self.state.src).unwrap_or_else(|| "<anonymous>".to_string())
    }

    pub(super) fn declaration_name_node(&self, node: Node<'t>) -> Option<Node<'t>> {
        node.child_by_field_name("name")
            .or_else(|| util::first_named_child_kind(node, "identifier"))
    }

    // --- the dispatcher (visitNode, Java-relevant branches) -----------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "class_declaration" {
            self.extract_class(node);
            skip_children = true;
        } else if is_method_type(kind) {
            self.extract_method(node);
            skip_children = true;
        } else if is_interface_type(kind) {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "field_declaration" && self.inside_class_like() {
            self.extract_field(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "local_variable_declaration" && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_declaration" {
            self.extract_import(node);
        } else if kind == "method_invocation" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                self.extract_anonymous_class(node, anon_body);
                skip_children = true;
            }
        }

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    // --- visitFunctionBody ----------------------------------------------------------

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "method_invocation" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                self.extract_anonymous_class(node, anon_body);
                return;
            }
        }

        // Static-member / value-read (`Type.CONST`) — self-gates on field_access.
        self.extract_static_member_ref(node);

        if kind == "class_declaration" {
            self.extract_class(node);
            return;
        }
        if kind == "enum_declaration" {
            self.extract_enum(node);
            return;
        }
        if is_interface_type(kind) {
            self.extract_interface(node);
            return;
        }

        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }

    pub(super) fn callable_extra(&self, node: Node<'t>) -> Extra {
        Extra {
            docstring: preceding_docstring(node, self.state.src),
            signature: self.signature_of(node),
            visibility: self.visibility_of(node),
            is_static: Some(self.is_static(node)),
            return_type: self.normalize_java_type(node.child_by_field_name("type")),
            ..Extra::default()
        }
    }

    pub(super) fn visit_callable_body(
        &mut self,
        row: u32,
        kind: &'static str,
        name: String,
        node: Node<'t>,
    ) {
        util::push_scope(&mut self.state.stack, row, kind, name);
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.state.stack.pop();
    }

    pub(super) fn constructor_node(&self, node: Node<'t>) -> Option<Node<'t>> {
        util::child_by_fields(node, &["constructor", "type", "name"], 0)
    }
}
