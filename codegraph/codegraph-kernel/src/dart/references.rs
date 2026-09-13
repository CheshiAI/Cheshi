//! references for the dart extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractImport (:3170; hook dart.ts:261-304) ----------------------

    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let find_child = |parent: Node<'t>, kind: &str| -> Option<Node<'t>> {
            let mut cursor = parent.walk();
            let found = parent
                .named_children(&mut cursor)
                .find(|c| c.kind() == kind);
            found
        };
        let uri_of = |spec: Node<'t>| -> Option<Node<'t>> {
            let configurable = find_child(spec, "configurable_uri")?;
            let uri = find_child(configurable, "uri")?;
            find_child(uri, "string_literal")
        };
        let mut module: Option<String> = None;
        if let Some(li) = find_child(node, "library_import") {
            if let Some(spec) = find_child(li, "import_specification") {
                if let Some(sl) = uri_of(spec) {
                    module = Some(self.text(sl).replace(['\'', '"'], ""));
                }
            }
        }
        if module.is_none() {
            if let Some(le) = find_child(node, "library_export") {
                if let Some(sl) = uri_of(le) {
                    module = Some(self.text(sl).replace(['\'', '"'], ""));
                }
            }
        }
        // Deferred imports (bare `uri`, no configurable_uri) → hook null →
        // nothing at all (invisible).
        let Some(module) = module.filter(|m| !m.is_empty()) else {
            return;
        };
        let signature = self.text(node).trim().to_string();
        let created = self.create_node(
            "import",
            &module,
            node,
            Extra {
                signature: Some(signature),
                ..Default::default()
            },
        );
        if created.is_some() && !self.stack.is_empty() {
            let parent_row = self.top_row();
            self.push_ref_at(parent_row, &module, "imports", node);
        }
    }

    // --- extractInstantiation (:4610, generic tail) -----------------------

    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let from_row = self.top_row();
        let ctor = node
            .child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        let Some(ctor) = ctor else { return };
        let class_name = util::strip_generic_and_qualifier(self.text(ctor));
        if class_name.is_empty() {
            return;
        }
        self.push_ref_at(from_row, &class_name, "instantiates", node);
    }

    // --- extractBareCall (dart.ts:305-379) --------------------------------

    pub(super) fn bare_call_name(&self, node: Node<'t>) -> Option<String> {
        if node.kind() == "selector" {
            let mut cursor = node.walk();
            let has_arg_part = node
                .named_children(&mut cursor)
                .any(|c| c.kind() == "argument_part");
            if !has_arg_part {
                return None;
            }
            let prev = node.prev_named_sibling()?;
            if prev.kind() == "identifier" {
                return Some(self.text(prev).to_string());
            }
            if prev.kind() == "selector" {
                let mut pc = prev.walk();
                let accessor = prev.named_children(&mut pc).find(|c| {
                    matches!(
                        c.kind(),
                        "unconditional_assignable_selector" | "conditional_assignable_selector"
                    )
                });
                if let Some(accessor) = accessor {
                    let mut ac = accessor.walk();
                    let method_id = accessor
                        .named_children(&mut ac)
                        .find(|c| c.kind() == "identifier");
                    if let Some(method_id) = method_id {
                        let accessor_prev = prev.prev_named_sibling();
                        if let Some(ap) = accessor_prev {
                            if ap.kind() == "identifier" {
                                return Some(format!("{}.{}", self.text(ap), self.text(method_id)));
                            }
                            // Chained static-factory: the receiver is itself
                            // a call — re-encode `<inner>().<method>` when
                            // the chain starts capitalized (#750).
                            if ap.kind() == "selector" {
                                let mut apc = ap.walk();
                                if ap
                                    .named_children(&mut apc)
                                    .any(|c| c.kind() == "argument_part")
                                {
                                    if let Some(inner) = self.callee_of_arg_part(ap) {
                                        if starts_upper_re().is_match(&inner) {
                                            return Some(format!(
                                                "{}().{}",
                                                inner,
                                                self.text(method_id)
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                        return Some(self.text(method_id).to_string());
                    }
                }
            }
            // super.method() / this.method(): prev is a bare accessor.
            if matches!(
                prev.kind(),
                "unconditional_assignable_selector" | "conditional_assignable_selector"
            ) {
                let mut pc = prev.walk();
                let id = prev
                    .named_children(&mut pc)
                    .find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    return Some(self.text(id).to_string());
                }
            }
            return None;
        }

        // new_expression arm — DEAD in practice (the INSTANTIATION branch
        // fires first in the body walker); ported for fidelity.
        if node.kind() == "new_expression" {
            let mut cursor = node.walk();
            let found = node
                .named_children(&mut cursor)
                .find(|c| c.kind() == "type_identifier")
                .map(|t| self.text(t).to_string());
            return found;
        }

        // const EdgeInsets.all(8.0) — const constructor call.
        if node.kind() == "const_object_expression" {
            let mut c1 = node.walk();
            let type_id = node
                .named_children(&mut c1)
                .find(|c| c.kind() == "type_identifier");
            let mut c2 = node.walk();
            let name_id = node
                .named_children(&mut c2)
                .find(|c| c.kind() == "identifier");
            return match (type_id, name_id) {
                (Some(t), Some(n)) => Some(format!("{}.{}", self.text(t), self.text(n))),
                (Some(t), None) => Some(self.text(t).to_string()),
                _ => None,
            };
        }

        None
    }

    /// dartCalleeOfArgPart (dart.ts:100-116).
    pub(super) fn callee_of_arg_part(&self, arg_part: Node<'t>) -> Option<String> {
        let prev = arg_part.prev_named_sibling()?;
        if prev.kind() == "identifier" {
            return Some(self.text(prev).to_string());
        }
        if prev.kind() == "selector" {
            let mut pc = prev.walk();
            let accessor = prev.named_children(&mut pc).find(|c| {
                matches!(
                    c.kind(),
                    "unconditional_assignable_selector" | "conditional_assignable_selector"
                )
            });
            let method_id = accessor.and_then(|a| util::first_named_child_kind(a, "identifier"));
            if let Some(method_id) = method_id {
                let accessor_prev = prev.prev_named_sibling();
                if let Some(ap) = accessor_prev {
                    if ap.kind() == "identifier" {
                        return Some(format!("{}.{}", self.text(ap), self.text(method_id)));
                    }
                }
                return Some(self.text(method_id).to_string());
            }
        }
        None
    }

    // --- extractStaticMemberRef — the dart branch (:4759-4767) ------------

    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let owner_row = self.top_row();
        if node.kind() != "selector" {
            return;
        }
        let mut cursor = node.walk();
        if node
            .named_children(&mut cursor)
            .any(|c| c.kind() == "argument_part")
        {
            return;
        }
        let Some(prev) = node.prev_named_sibling() else {
            return;
        };
        if prev.kind() == "identifier" && cap_ident_re().is_match(self.text(prev)) {
            let name = self.text(prev).to_string();
            // NO callee-of-call skip — `ConfigT.load()` double-emits
            // (references + calls). Position = the IDENTIFIER (receiver).
            self.push_ref_at(owner_row, &name, "references", prev);
        }
    }

    // --- extractDecoratorsFor (:4897-5024) — the sibling scan -------------

    pub(super) fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for decorator in util::decorator_nodes(decl) {
            self.consider_decorator(decorator, decorated_row);
        }
    }

    pub(super) fn consider_decorator(&mut self, node: Node<'t>, decorated_row: u32) {
        if let Some(name) = util::decorator_name(node, self.src) {
            self.push_ref_at(decorated_row, &name, "decorates", node);
        }
    }

    // --- extractInheritance — the dart rows (:5368-5393, :5437-5459) ------

    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in kids {
            if child.kind() == "superclass" {
                // extends type + `with` mixins (implements) — dart branch.
                let mut cc = child.walk();
                let targets: Vec<Node<'t>> = child.named_children(&mut cc).collect();
                for t in targets {
                    if t.kind() == "mixins" {
                        let mut mc = t.walk();
                        let mixins: Vec<Node<'t>> = t.named_children(&mut mc).collect();
                        for m in mixins {
                            if m.kind() == "type_identifier" {
                                let name = self.text(m).to_string();
                                self.push_ref_at(class_row, &name, "implements", m);
                            }
                        }
                    } else if t.kind() == "type_identifier" {
                        let name = self.text(t).to_string();
                        self.push_ref_at(class_row, &name, "extends", t);
                    }
                }
            } else if child.kind() == "interfaces" {
                // implements — one per named child, FULL child text.
                let mut cc = child.walk();
                let targets: Vec<Node<'t>> = child.named_children(&mut cc).collect();
                for iface in targets {
                    let name = self.text(iface).to_string();
                    self.push_ref_at(class_row, &name, "implements", iface);
                }
            }
        }
    }

    // --- extractTypeAnnotations — the dart path (:5819-5833) --------------

    pub(super) fn extract_type_annotations(&mut self, node: Node<'t>, row: u32) {
        let sig = if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let found = node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "function_signature"
                        | "getter_signature"
                        | "setter_signature"
                        | "constructor_signature"
                        | "factory_constructor_signature"
                )
            });
            found.unwrap_or(node) // operators fall back to the wrapper itself
        } else {
            node
        };
        self.type_refs_from_subtree(sig, row);
    }

    pub(super) fn type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        if node.kind() == "type_identifier" {
            let name = self.text(node);
            if !name.is_empty() && !is_builtin_type(name) {
                let name = name.to_string();
                self.push_ref_at(from_row, &name, "references", node);
            }
            return;
        }
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for c in kids {
            self.type_refs_from_subtree(c, from_row);
        }
    }
}
