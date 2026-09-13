//! walker for the go extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
    }

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
        let qualified = extra.qualified_name.clone().unwrap_or_else(|| {
            util::join_qualified_name(
                self.state
                    .stack
                    .iter()
                    .filter(|scope| scope.kind != "file")
                    .map(|scope| scope.name.as_str()),
                name,
            )
        });
        let row = util::emit_node_row(
            &mut self.state,
            kind,
            name,
            node,
            util::NodeExtra {
                docstring: extra.docstring,
                signature: extra.signature,
                qualified_name: Some(qualified.clone()),
                is_exported: extra.is_exported,
                return_type: extra.return_type,
                ..util::NodeExtra::default()
            },
        )?;
        self.nodes_meta.push(NodeMeta {
            kind,
            name: name.to_string(),
        });
        util::record_node_bookkeeping(
            &mut self.state,
            kind,
            name,
            node,
            row,
            matches!(kind, "function" | "method"),
        );
        Some(row)
    }

    pub(super) fn extract_name(&self, node: Node) -> String {
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                if matches!(
                    c.kind(),
                    "identifier" | "type_identifier" | "simple_identifier" | "constant"
                ) {
                    return self.text(c).to_string();
                }
            }
        }
        "<anonymous>".to_string()
    }

    /// goExtractor.getSignature: params + ' ' + result.
    pub(super) fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if let Some(result) = node.child_by_field_name("result") {
            sig.push(' ');
            sig.push_str(self.text(result));
        }
        Some(sig)
    }

    /// goExtractor.isExported: uppercase first letter of the name field.
    pub(super) fn is_exported(&self, node: Node) -> bool {
        if let Some(name_node) = node.child_by_field_name("name") {
            let text = self.text(name_node);
            return text
                .as_bytes()
                .first()
                .map(|b| b.is_ascii_uppercase())
                .unwrap_or(false);
        }
        false
    }

    /// extractGoReturnType (languages/go.ts).
    pub(super) fn return_type_of(&self, node: Node) -> Option<String> {
        let mut result = node.child_by_field_name("result")?;
        if result.kind() == "parameter_list" {
            let first = (0..result.named_child_count())
                .filter_map(|i| result.named_child(i))
                .find(|c| c.kind() == "parameter_declaration")?;
            result = first.child_by_field_name("type").unwrap_or(first);
        }
        if result.kind() == "pointer_type" {
            result = (0..result.named_child_count())
                .filter_map(|i| result.named_child(i))
                .find(|c| {
                    matches!(
                        c.kind(),
                        "type_identifier" | "qualified_type" | "generic_type"
                    )
                })
                .unwrap_or(result);
        }
        let text = self.text(result).trim();
        let text = text.strip_prefix('*').unwrap_or(text);
        let text = generic_angle_re().replace_all(text, "");
        let text = bracket_args_re().replace_all(&text, "");
        let last = text.rsplit('.').next().unwrap_or("").trim().to_string();
        if last.is_empty() || !simple_ident_re().is_match(&last) {
            return None;
        }
        Some(last)
    }

    /// goExtractor.getReceiverType: the regex over the receiver's text.
    pub(super) fn receiver_type_of(&self, node: Node) -> Option<String> {
        let receiver = node.child_by_field_name("receiver")?;
        let text = self.text(receiver);
        receiver_re().captures(text).map(|c| c[1].to_string())
    }

    // --- visitNode ------------------------------------------------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_declaration" {
            self.extract_function(node);
            skip_children = true;
        } else if kind == "method_declaration" {
            self.extract_method(node);
            skip_children = true;
        } else if kind == "type_spec" {
            skip_children = self.extract_type_alias(node);
        } else if matches!(
            kind,
            "var_declaration" | "short_var_declaration" | "const_declaration"
        ) && !self.inside_class_like()
        {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_declaration" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "composite_literal" {
            self.extract_instantiation(node);
        }

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "composite_literal" {
            self.extract_instantiation(node);
        }

        if kind == "function_declaration" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    /// extractGoInterfaceMethods: method_elem/method_spec → method nodes.
    pub(super) fn extract_go_interface_methods(
        &mut self,
        interface_type: Node<'t>,
        iface_row: u32,
        iface_name: &str,
    ) {
        util::push_scope(
            &mut self.state.stack,
            iface_row,
            "interface",
            iface_name.to_string(),
        );
        for i in 0..interface_type.named_child_count() {
            let Some(m) = interface_type.named_child(i) else {
                continue;
            };
            if !matches!(m.kind(), "method_elem" | "method_spec") {
                continue;
            }
            let name_node = m.child_by_field_name("name").or_else(|| m.named_child(0));
            let Some(name_node) = name_node else { continue };
            let mname = self.text(name_node).to_string();
            if !mname.is_empty() {
                let signature = self.signature_of(m);
                self.create_node(
                    "method",
                    &mname,
                    m,
                    Extra {
                        signature,
                        ..Extra::default()
                    },
                );
            }
        }
        self.state.stack.pop();
    }
}
