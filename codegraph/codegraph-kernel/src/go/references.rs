//! references for the go extractor.

use super::*;

impl<'t> Walker<'t> {
    /// extractImport's Go branch: one import node + ref per import_spec.
    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let parent = self.top_row();
        let imports_kind = edge_kind_index("imports").unwrap();
        let handle_spec = |w: &mut Self, spec: Node<'t>| {
            let lit = (0..spec.named_child_count())
                .filter_map(|i| spec.named_child(i))
                .find(|c| c.kind() == "interpreted_string_literal");
            let Some(lit) = lit else { return };
            let import_path: String = w
                .text(lit)
                .chars()
                .filter(|c| *c != '\'' && *c != '"')
                .collect();
            if import_path.is_empty() {
                return;
            }
            let signature = w.text(spec).trim().to_string();
            w.create_node(
                "import",
                &import_path,
                spec,
                Extra {
                    signature: Some(signature),
                    ..Extra::default()
                },
            );
            w.push_ref_at(parent, &import_path, imports_kind, spec);
        };

        let spec_list = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "import_spec_list");
        if let Some(list) = spec_list {
            for i in 0..list.named_child_count() {
                if let Some(spec) = list.named_child(i) {
                    if spec.kind() == "import_spec" {
                        handle_spec(self, spec);
                    }
                }
            }
        } else {
            let spec = (0..node.named_child_count())
                .filter_map(|i| node.named_child(i))
                .find(|c| c.kind() == "import_spec");
            if let Some(spec) = spec {
                handle_spec(self, spec);
            }
        }
    }

    /// extractCall — Go's generic-tail paths (selector_expression callees).
    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.state.stack.is_empty() {
            return;
        }
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let mut callee_name = String::new();

        if let Some(func) = func {
            if func.kind() == "selector_expression" {
                let property = func
                    .child_by_field_name("property")
                    .or_else(|| func.child_by_field_name("field"));
                if let Some(property) = property {
                    let method_name = self.text(property);
                    let receiver = func
                        .child_by_field_name("object")
                        .or_else(|| func.child_by_field_name("operand"))
                        .or_else(|| func.child_by_field_name("argument"))
                        .or_else(|| func.named_child(0));
                    if let Some(r) = receiver {
                        if is_literal_receiver(r.kind()) {
                            return;
                        }
                    }
                    if let Some(r) = receiver {
                        match r.kind() {
                            "identifier" | "simple_identifier" | "field_identifier" => {
                                let receiver_name = self.text(r);
                                if !matches!(receiver_name, "self" | "this" | "cls" | "super") {
                                    callee_name = format!("{receiver_name}.{method_name}");
                                } else {
                                    callee_name = method_name.to_string();
                                }
                            }
                            "call_expression" => {
                                // Bare package-level factory chain `New().Method()`
                                // re-encodes; instance chains keep the bare name.
                                let inner_fn = r.child_by_field_name("function");
                                let reencode =
                                    inner_fn.map(|f| f.kind() == "identifier").unwrap_or(false);
                                if reencode {
                                    let inner: String = self
                                        .text(inner_fn.unwrap())
                                        .replace("->", ".")
                                        .chars()
                                        .filter(|c| !c.is_whitespace())
                                        .collect();
                                    callee_name = format!("{inner}().{method_name}");
                                } else {
                                    callee_name = method_name.to_string();
                                }
                            }
                            "selector_expression" => {
                                // 2-hop field chain `t.conn.Exec` (#1276).
                                let chain: String = self
                                    .text(r)
                                    .chars()
                                    .filter(|c| !c.is_whitespace())
                                    .collect();
                                if go_two_hop_re().is_match(&chain) {
                                    callee_name = format!("{chain}.{method_name}");
                                } else {
                                    callee_name = method_name.to_string();
                                }
                            }
                            _ => {
                                callee_name = method_name.to_string();
                            }
                        }
                    } else {
                        callee_name = method_name.to_string();
                    }
                }
            } else {
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            // `(*T)(x)` conversions normalize to `T`.
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
            let from = self.top_row();
            self.push_ref_at(
                from,
                &callee_name.clone(),
                edge_kind_index("calls").unwrap(),
                node,
            );
        }
    }

    /// extractInstantiation's composite_literal branch: named struct types
    /// only; the package qualifier is KEPT.
    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.state.stack.is_empty() {
            return;
        }
        let ctor = util::child_by_fields(node, &["constructor", "type", "name"], 0);
        let Some(ctor) = ctor else { return };
        if !matches!(ctor.kind(), "type_identifier" | "qualified_type") {
            return;
        }
        let mut go_type = self.text(ctor).trim().to_string();
        if let Some(br) = go_type.find('[') {
            if br > 0 {
                go_type.truncate(br);
                go_type = go_type.trim().to_string();
            }
        }
        if !go_type.is_empty() {
            let from = self.top_row();
            self.push_ref_at(
                from,
                &go_type,
                edge_kind_index("instantiates").unwrap(),
                node,
            );
        }
    }

    /// extractInheritance — the Go branches: interface embedding
    /// (constraint_elem) and struct embedding (field_declaration without a
    /// field_identifier), plus the field_declaration_list recursion.
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            match child.kind() {
                "constraint_elem" => {
                    let type_id = (0..child.named_child_count())
                        .filter_map(|j| child.named_child(j))
                        .find(|c| c.kind() == "type_identifier");
                    if let Some(type_id) = type_id {
                        let name = self.text(type_id).to_string();
                        self.push_ref_at(class_row, &name, extends_kind, type_id);
                    }
                }
                "field_declaration" => {
                    let has_field_identifier = (0..child.named_child_count())
                        .filter_map(|j| child.named_child(j))
                        .any(|c| c.kind() == "field_identifier");
                    if !has_field_identifier {
                        let type_id = (0..child.named_child_count())
                            .filter_map(|j| child.named_child(j))
                            .find(|c| c.kind() == "type_identifier");
                        if let Some(type_id) = type_id {
                            let name = self.text(type_id).to_string();
                            self.push_ref_at(class_row, &name, extends_kind, type_id);
                        }
                    }
                }
                "field_declaration_list" | "class_heritage" => {
                    self.extract_inheritance(child, class_row);
                }
                _ => {}
            }
        }
    }

    /// extractTypeAnnotations — Go's returnField is `result`.
    pub(super) fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if let Some(params) = node.child_by_field_name("parameters") {
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("result") {
            self.extract_type_refs_from_subtree(ret, from_row);
        }
        let type_annotation = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = type_annotation {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    pub(super) fn extract_type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        if node.kind() == "type_identifier" {
            let type_name = self.text(node).to_string();
            if !type_name.is_empty() && !is_builtin_type(&type_name) {
                self.push_ref_at(
                    from_row,
                    &type_name,
                    edge_kind_index("references").unwrap(),
                    node,
                );
            }
            return;
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.extract_type_refs_from_subtree(c, from_row);
            }
        }
    }
}
