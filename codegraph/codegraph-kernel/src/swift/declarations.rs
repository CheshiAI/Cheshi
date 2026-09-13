//! declarations for the swift extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn visit_class_like_declaration(&mut self, node: Node<'t>) {
        match Self::classify_declaration(node) {
            "struct" => self.extract_struct(node),
            "enum" => self.extract_enum(node),
            _ => self.extract_class(node),
        }
    }

    /// THE DEDICATED PROPERTY BRANCH (tree-sitter.ts:1113-1193, #1020).
    /// Returns skipChildren.
    pub(super) fn dedicated_property_branch(&mut self, node: Node<'t>) -> bool {
        let owner_row = self.top_row();
        let info = self.swift_property_info(node);
        let mut computed_prop: Option<(u32, String)> = None;

        if let Some(name_node) = info.name_node {
            let name = self.text(name_node).to_string();
            if info.is_computed {
                let row = self.create_node(
                    "property",
                    &name,
                    node,
                    self.member_extra(node, self.is_static(node)),
                );
                if let Some(row) = row {
                    computed_prop = Some((row, name));
                }
            } else {
                let is_static = self.is_static(node);
                let kind: &'static str = if is_static {
                    if info.is_let {
                        "constant"
                    } else {
                        "variable"
                    }
                } else {
                    "field"
                };
                self.create_node(kind, &name, node, self.member_extra(node, is_static));
            }
        }

        // All three ref passes attach to the ENCLOSING TYPE (ownerId).
        self.extract_decorators_for(node, owner_row);
        // extractVariableTypeAnnotation: the direct type_annotation child.
        let ta = util::first_named_child_kind(node, "type_annotation");
        if let Some(ta) = ta {
            self.extract_type_refs_from_subtree(ta, owner_row);
        }
        // walkAttrArgs: extractStaticMemberRef over the whole modifiers subtree
        // (`@Siblings(through: Pivot.self)` metatype args).
        let mods = util::first_named_child_kind(node, "modifiers");
        if let Some(mods) = mods {
            self.walk_attr_args(mods);
        }

        if let Some((row, name)) = computed_prop {
            let getter = util::first_named_child_kind_any(
                node,
                &["computed_property", "protocol_property_requirements"],
            );
            if let Some(getter) = getter {
                self.stack.push(Scope {
                    row,
                    kind: "property",
                    name,
                });
                self.visit_function_body(getter);
                self.stack.pop();
            }
            return true; // skipChildren — computed only
        }
        // Stored: descend generically — initializer calls attribute to the
        // CLASS; observers' bodies likewise; modifiers re-walk is harmless.
        false
    }

    // --- extractors -----------------------------------------------------------------

    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        self.extract_callable(node, "function", name);
    }

    pub(super) fn extract_callable(&mut self, node: Node<'t>, kind: &'static str, name: String) {
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None, // getSignature reads the never-resolving 'parameter' field
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)), // present-false (dead hook)
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node(kind, &name, node, extra) else {
            return;
        };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        if let Some(body) = node.child_by_field_name("body") {
            self.stack.push(Scope { row, kind, name });
            self.visit_function_body(body);
            self.stack.pop();
        }
    }

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        self.extract_callable(node, "method", name);
    }

    pub(super) fn extract_class(&mut self, node: Node<'t>) {
        self.extract_class_or_struct(node, "class");
    }

    pub(super) fn extract_struct(&mut self, node: Node<'t>) {
        self.extract_class_or_struct(node, "struct");
    }

    pub(super) fn extract_class_or_struct(&mut self, node: Node<'t>, kind: &'static str) {
        let body = if kind == "struct" {
            // Body gate (:1876) — bodiless mints nothing (record exemption is C#).
            let Some(body) = node.child_by_field_name("body") else {
                return;
            };
            body
        } else {
            node.child_by_field_name("body").unwrap_or(node)
        };
        let name = self.extract_name(node);
        let Some(row) = self.create_node(kind, &name, node, self.declaration_extra(node)) else {
            return;
        };
        self.extract_inheritance(node, row);
        if kind == "class" {
            // Classes DO get decorates (`@Observable class`), unlike struct/enum.
            self.extract_decorators_for(node, row);
        }
        self.visit_scope_body(body, row, kind, name);
    }

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let Some(row) = self.create_node("enum", &name, node, self.declaration_extra(node)) else {
            return;
        };
        // Raw-value types ride inheritance (`enum Suit: String` → extends
        // String — extends refs have NO builtin filter). NO decorates.
        self.extract_inheritance(node, row);
        self.with_scope(row, "enum", name, |walker| {
            for child in util::named_children(body) {
                if child.kind() == "enum_entry" {
                    walker.extract_enum_members(child);
                } else {
                    walker.visit_node(child);
                }
            }
        });
    }

    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        // `name` field = the FIRST case name only — `case put, delete` mints
        // ONLY `put` (the identifier-scan fallback is dead, the field always
        // resolves). Associated/raw values never walked.
        self.create_named_field_node("enum_member", node, Extra::default());
    }

    pub(super) fn create_named_field_node(
        &mut self,
        kind: &'static str,
        node: Node<'t>,
        extra: Extra,
    ) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = self.text(name_node).to_string();
        self.create_node(kind, &name, node, extra);
    }

    pub(super) fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = self.docstring_extra(node); // NO visibility, NO decorates
        let Some(row) = self.create_node("interface", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        let body = node.child_by_field_name("body").unwrap_or(node);
        self.visit_scope_body(body, row, "interface", name);
    }

    /// extractTypeAlias (:2890) — plain type_alias node + value-subtree type
    /// refs (`typealias Handler = (Data) -> Void` → refs Data + Void…Void is
    /// builtin-suppressed; `= KF.Builder` → refs KF AND Builder). Returns
    /// skipChildren=false (children also recursed, harmlessly).
    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let extra = self.docstring_extra(node);
        let row = self.create_node("type_alias", &name, node, extra);
        if let Some(row) = row {
            if let Some(value) = node.child_by_field_name("value") {
                self.extract_type_refs_from_subtree(value, row);
            }
        }
        false
    }

    /// extractVariable — the swift top-level branch (:2851): let → constant /
    /// var → variable via swiftPropertyInfo; computed skipped; position = the
    /// whole declaration; extras = docstring + isExported literal FALSE.
    pub(super) fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let info = self.swift_property_info(node);
        let Some(name_node) = info.name_node else {
            return;
        };
        if info.is_computed {
            return;
        }
        let kind: &'static str = if info.is_let { "constant" } else { "variable" };
        let name = self.text(name_node).to_string();
        self.create_node(
            kind,
            &name,
            node,
            Extra {
                docstring,
                is_exported: Some(false),
                ..Extra::default()
            },
        );
    }
}
