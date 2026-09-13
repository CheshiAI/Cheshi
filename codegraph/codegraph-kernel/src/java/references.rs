//! references for the java extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let scoped = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "scoped_identifier");
        let Some(scoped) = scoped else { return }; // hook declined
        let module_name = self.text(scoped).to_string();
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
        self.push_ref_at(
            parent,
            &module_name.clone(),
            edge_kind_index("imports").unwrap(),
            node,
        );
    }

    /// extractCall — the Java method_invocation paths.
    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.state.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let name_field = node.child_by_field_name("name");
        let object_field = node
            .child_by_field_name("object")
            .or_else(|| node.child_by_field_name("scope"));

        let mut callee_name = String::new();
        if let (Some(name_field), Some(object_field)) = (name_field, object_field) {
            let method_name = self.text(name_field);

            // Static-factory / fluent chain: `Foo.getInstance().bar()` →
            // `<inner-receiver>.<inner-method>().<method>` (#645/#608).
            if !method_name.is_empty() && object_field.kind() == "method_invocation" {
                let inner_obj = object_field.child_by_field_name("object");
                let inner_name = object_field.child_by_field_name("name");
                if let (Some(io), Some(inm)) = (inner_obj, inner_name) {
                    let callee = format!("{}.{}().{}", self.text(io), self.text(inm), method_name);
                    self.push_ref_at(caller, &callee, edge_kind_index("calls").unwrap(), node);
                    return;
                }
            }

            // `this.userbo.toLogin2()` — unwrap the field after `this.`.
            let receiver_name = if object_field.kind() == "field_access" {
                let inner = object_field.child_by_field_name("object");
                let fld = object_field.child_by_field_name("field");
                match (inner, fld) {
                    (Some(inner), Some(fld))
                        if matches!(inner.kind(), "this" | "this_expression") =>
                    {
                        self.text(fld).to_string()
                    }
                    _ => self.text(object_field).to_string(),
                }
            } else {
                self.text(object_field).to_string()
            };
            let receiver_name = receiver_name.strip_prefix('$').unwrap_or(&receiver_name);

            if !method_name.is_empty() {
                if matches!(
                    receiver_name,
                    "self" | "this" | "cls" | "super" | "parent" | "static"
                ) {
                    callee_name = method_name.to_string();
                } else {
                    callee_name = format!("{receiver_name}.{method_name}");
                }
            }
        } else {
            // Bare call `foo()` — the generic tail: function field ?? first child.
            let func = node
                .child_by_field_name("function")
                .or_else(|| node.named_child(0));
            if let Some(func) = func {
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            util::emit_state_call_ref(&mut self.state, caller, &callee_name, node);
        }
    }

    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.state.stack.is_empty() {
            return;
        }
        let ctor = self.constructor_node(node);
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

    /// extractStaticMemberRef — `Type.CONST` value reads (java: field_access).
    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "field_access" {
            return;
        }
        if self.state.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        // Skip `Type.method()` — the access is a call's callee, already linked.
        if let Some(parent) = node.parent() {
            if parent.kind() == "method_invocation" {
                let callee = parent
                    .child_by_field_name("function")
                    .or_else(|| parent.child_by_field_name("method"))
                    .or_else(|| parent.named_child(0));
                if let Some(callee) = callee {
                    if callee.start_byte() == node.start_byte() {
                        return;
                    }
                }
            }
        }
        let recv = node
            .child_by_field_name("object")
            .or_else(|| node.child_by_field_name("expression"))
            .or_else(|| node.child_by_field_name("scope"))
            .or_else(|| node.named_child(0));
        let Some(recv) = recv else { return };
        if matches!(
            recv.kind(),
            "identifier"
                | "type_identifier"
                | "simple_identifier"
                | "name"
                | "scoped_type_identifier"
        ) {
            let text = self.text(recv);
            if capitalized_re().is_match(text) {
                self.push_ref_at(owner, text, edge_kind_index("references").unwrap(), recv);
            }
        }
    }

    /// extractInheritance — the Java clauses (type_list-aware).
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        let implements_kind = edge_kind_index("implements").unwrap();
        for child in util::named_children(node) {
            match child.kind() {
                "superclass" | "extends_interfaces" => {
                    for target in self.inheritance_targets(child, true) {
                        let name = self.text(target).to_string();
                        self.push_ref_at(class_row, &name, extends_kind, target);
                    }
                }
                "super_interfaces" => {
                    for iface in self.inheritance_targets(child, false) {
                        let name = self.text(iface).to_string();
                        self.push_ref_at(class_row, &name, implements_kind, iface);
                    }
                }
                _ => {}
            }
        }
    }

    pub(super) fn inheritance_targets(&self, clause: Node<'t>, first_only: bool) -> Vec<Node<'t>> {
        if let Some(type_list) = util::first_named_child_kind(clause, "type_list") {
            return util::named_children(type_list).collect();
        }
        if first_only {
            clause.named_child(0).into_iter().collect()
        } else {
            util::named_children(clause).collect()
        }
    }

    /// extractDecoratorsFor — Java annotations live inside `modifiers`.
    pub(super) fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for node in util::decorator_nodes(decl) {
            self.consider_decorator(node, decorated_row);
        }
    }

    pub(super) fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        let Some(name) = util::decorator_name(n, self.state.src) else {
            return;
        };
        util::emit_state_decorator_ref(&mut self.state, decorated_row, &name, n);
    }

    /// extractTypeAnnotations — Java's returnField is `type`.
    pub(super) fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if let Some(params) = node.child_by_field_name("parameters") {
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("type") {
            self.extract_type_refs_from_subtree(ret, from_row);
        }
        let type_annotation = util::first_named_child_kind(node, "type_annotation");
        if let Some(ta) = type_annotation {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    pub(super) fn extract_type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        let references_kind = edge_kind_index("references").unwrap();
        util::walk_type_identifier_nodes(node, &mut |type_node| {
            let type_name = self.text(type_node).to_string();
            if !type_name.is_empty() && !is_builtin_type(&type_name) {
                self.push_ref_at(from_row, &type_name, references_kind, type_node);
            }
        });
    }
}
