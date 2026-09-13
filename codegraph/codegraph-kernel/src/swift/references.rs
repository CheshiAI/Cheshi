//! references for the swift extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn emit_call_ref(&mut self, caller: u32, mut callee: String, node: Node) {
        if callee.is_empty() {
            return;
        }
        if let Some(capture) = util::paren_conversion().captures(&callee) {
            callee = capture[1].to_string();
        }
        self.push_ref_at(caller, &callee, edge_kind_index("calls").unwrap(), node);
    }

    pub(super) fn is_call_callee(&self, node: Node) -> bool {
        let Some(parent) = node.parent() else {
            return false;
        };
        if parent.kind() != "call_expression" {
            return false;
        }
        util::child_by_fields(parent, &["function", "method"], 0)
            .is_some_and(|callee| callee.start_byte() == node.start_byte())
    }

    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let identifier = util::first_named_child_kind(node, "identifier");
        let Some(identifier) = identifier else { return }; // hook null → nothing
        let module_name = self.text(identifier).to_string();
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

    /// extractCall — swift rides the generic member branch (navigation) and
    /// the raw-text else; the full matrix is in the checklist.
    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };
        let mut callee_name = String::new();

        if func.kind() == "navigation_expression" {
            // property = property/field fields (null) → namedChild(1), with
            // the navigation_suffix simple_identifier unwrap.
            let property = func
                .child_by_field_name("property")
                .or_else(|| func.child_by_field_name("field"))
                .or_else(|| {
                    let c1 = func.named_child(1);
                    match c1 {
                        Some(c) if c.kind() == "navigation_suffix" => {
                            util::first_named_child_kind(c, "simple_identifier").or(Some(c))
                        }
                        other => other,
                    }
                });
            if let Some(property) = property {
                let method_name = self.text(property);
                let receiver = util::child_by_fields(func, &["object", "operand", "argument"], 0);
                if let Some(r) = receiver {
                    if util::is_literal_receiver_kind(r.kind()) {
                        return; // `"lit".upper()` / `5.times()` — nothing
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
                } else if receiver
                    .map(|r| r.kind() == "call_expression")
                    .unwrap_or(false)
                {
                    // #750 swift re-encode: innerNav = receiver.namedChild(0),
                    // ws-stripped; capitalized chains only.
                    let inner = receiver.unwrap().named_child(0);
                    let inner_callee = inner
                        .map(|n| util::strip_js_whitespace(self.text(n)))
                        .unwrap_or_default();
                    let reencode = inner_callee
                        .as_bytes()
                        .first()
                        .map(|b| b.is_ascii_uppercase())
                        .unwrap_or(false);
                    let receiver = reencode.then(|| format!("{inner_callee}()"));
                    callee_name = util::compose_member_callee(receiver.as_deref(), method_name);
                } else {
                    // self_expression / super_expression / inner nav /
                    // postfix / multi_line_string_literal → bare method name.
                    callee_name = util::compose_member_callee(None, method_name);
                }
            }
        } else {
            // Raw func text: bare `helper`, `Foo` (constructor = plain call),
            // `arr` (subscript reads!), `m[i]`, `defer`, `.make`, tuple
            // callees (conv-regex below), array-literal callees (bump delta 8).
            callee_name = self.text(func).to_string();
        }

        self.emit_call_ref(caller, callee_name, node);
    }

    /// extractStaticMemberRef — swift's navigation_expression value reads,
    /// body walker + walkAttrArgs only.
    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "navigation_expression" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        // Skip the callee nav of a call.
        if self.is_call_callee(node) {
            return;
        }
        let recv = util::child_by_fields(node, &["object", "expression", "scope"], 0);
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
            if util::is_capitalized_identifier(text) {
                self.push_ref_at(owner, text, edge_kind_index("references").unwrap(), recv);
            }
        }
    }

    /// extractInheritance — the swift inheritance_specifier case: FIRST
    /// type_identifier of each specifier's user_type, everything as `extends`
    /// (conformances included; `: Module.Base` takes `Module`).
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for child in
            util::named_children(node).filter(|child| child.kind() == "inheritance_specifier")
        {
            let user_type = util::first_named_child_kind(child, "user_type");
            let Some(user_type) = user_type else { continue };
            let type_id = util::first_named_child_kind(user_type, "type_identifier");
            let Some(type_id) = type_id else { continue };
            let name = self.text(type_id).to_string();
            self.push_ref_at(class_row, &name, extends_kind, type_id);
        }
    }

    /// extractTypeAnnotations — generic path: the 'parameter' field NEVER
    /// resolves (zero param refs), 'return_type' DOES; the direct
    /// type_annotation find is null for functions.
    pub(super) fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        for field in ["parameter", "return_type"] {
            if let Some(type_node) = node.child_by_field_name(field) {
                self.extract_type_refs_from_subtree(type_node, from_row);
            }
        }
        let ta = util::first_named_child_kind(node, "type_annotation");
        if let Some(ta) = ta {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    pub(super) fn extract_type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        for node in util::named_subtree_preorder(node) {
            if node.kind() != "type_identifier" {
                continue;
            }
            let type_name = self.text(node).to_string();
            if !type_name.is_empty() && !is_builtin_type(&type_name) {
                self.push_ref_at(
                    from_row,
                    &type_name,
                    edge_kind_index("references").unwrap(),
                    node,
                );
            }
        }
    }

    /// extractDecoratorsFor — swift `attribute` nodes inside `modifiers`.
    /// Coverage: functions/methods/classes/dedicated-branch properties only.
    pub(super) fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        let decorators = util::decorator_nodes(decl);
        let edge_kind = edge_kind_index("decorates").unwrap();
        for decorator in decorators {
            let Some(name) = util::decorator_name(decorator, self.src) else {
                continue;
            };
            self.push_ref_at(decorated_row, &name, edge_kind, decorator);
        }
    }
}
