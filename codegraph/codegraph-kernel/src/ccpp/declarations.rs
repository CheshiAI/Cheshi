//! declarations for the ccpp/mod extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn create_named_member(&mut self, kind: &'static str, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node(kind, &name, node, Extra::default());
        }
    }

    // --- extractors ----------------------------------------------------------

    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        // Receiver present (out-of-line `Cls::method` def) → method instead.
        if self.variant == Variant::Cpp && self.receiver_type_of(node).is_some() {
            self.extract_method(node);
            return;
        }

        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        // Misparse artifacts: drop the node, still walk the body (#946/#1061).
        if self.is_misparsed_function(&name, node) {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }

        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: if self.variant == Variant::Cpp {
                self.visibility_of(node)
            } else {
                None
            },
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };
        // (extractTypeAnnotations + extractDecoratorsFor are structural no-ops
        // for c/cpp: not in TYPE_ANNOTATION_LANGUAGES, and the decorator node
        // kinds never appear as direct children/preceding siblings in these
        // grammars — `attribute` only occurs under attribute_declaration.)
        self.with_scope(row, "function", name, |this| {
            if let Some(body) = node.child_by_field_name("body") {
                this.visit_function_body(body);
            }
        });
    }

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        let receiver_type = if self.variant == Variant::Cpp {
            self.receiver_type_of(node)
        } else {
            None
        };

        if !self.inside_class_like() && receiver_type.is_none() {
            // (object-literal parents don't occur in c/cpp) — treat as function.
            self.extract_function(node);
            return;
        }

        let name = self.extract_name(node);
        if self.is_misparsed_function(&name, node) {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }

        let mut extra = self.declaration_extra(node);
        extra.return_type = self.return_type_of(node);
        extra.qualified_name = receiver_type
            .as_ref()
            .map(|r| self.compose_receiver_qualified_name(r, &name));
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };

        // Out-of-line def: contains edge from the FIRST earlier-in-file
        // struct/class/enum/trait node of the receiver's name.
        if let Some(receiver_type) = &receiver_type {
            if !self.inside_class_like() {
                let owner_row = self.owner_row_for_type(receiver_type);
                if let Some(owner_row) = owner_row {
                    self.push_edge(
                        owner_row,
                        row,
                        edge_kind_index("contains").unwrap(),
                        NONE_STR,
                    );
                }
            }
        }

        self.with_scope(row, "method", name, |this| {
            if let Some(body) = node.child_by_field_name("body") {
                this.visit_function_body(body);
            }
        });
    }

    /// extractClass for cpp class_specifier (skipBodilessClass, #1093).
    pub(super) fn extract_class(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let extra = self.declaration_extra(node);
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.with_scope(row, "class", name, |this| this.visit_children(body));
    }

    /// extractStruct: bodiless specifiers (fwd decls / elaborated refs) skip.
    pub(super) fn extract_struct(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let extra = self.declaration_extra(node);
        let Some(row) = self.create_node("struct", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.with_scope(row, "struct", name, |this| this.visit_children(body));
    }

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let extra = self.declaration_extra(node);
        let Some(row) = self.create_node("enum", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.with_scope(row, "enum", name, |this| this.visit_enum_body(body));
    }

    /// extractEnumMembers: enumerator's `name` field (C/C++ always has one;
    /// the TS fallbacks for other grammars are unreachable here).
    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        self.create_named_member("enum_member", node);
    }

    /// extractTypeAlias for type_definition / alias_declaration. Returns true
    /// when children were consumed (typedef struct/enum bodies).
    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring(node, self.src);

        // resolveTypeAliasKind: first child that is an enum/struct specifier
        // WITH a body decides the node kind (anon inner specifier takes the
        // typedef's name).
        let mut resolved: Option<&'static str> = None;
        for child in named_children(node) {
            if child.kind() == "enum_specifier" && child.child_by_field_name("body").is_some() {
                resolved = Some("enum");
                break;
            }
            if child.kind() == "struct_specifier" && child.child_by_field_name("body").is_some() {
                resolved = Some("struct");
                break;
            }
        }

        if resolved == Some("struct") {
            let Some(row) = self.create_node(
                "struct",
                &name,
                node,
                Extra {
                    docstring,
                    ..Extra::default()
                },
            ) else {
                return true;
            };
            let type_child = node
                .child_by_field_name("type")
                .or_else(|| self.find_child_by_kind(node, "struct_specifier"));
            self.with_scope(row, "struct", name, |this| {
                if let Some(tc) = type_child {
                    this.extract_inheritance(tc, row);
                    let body = tc.child_by_field_name("body").unwrap_or(tc);
                    this.visit_children(body);
                }
            });
            return true;
        }

        if resolved == Some("enum") {
            let Some(row) = self.create_node(
                "enum",
                &name,
                node,
                Extra {
                    docstring,
                    ..Extra::default()
                },
            ) else {
                return true;
            };
            let inner = self.find_child_by_kind(node, "enum_specifier");
            self.with_scope(row, "enum", name, |this| {
                if let Some(inner) = inner {
                    this.extract_inheritance(inner, row);
                    if let Some(body) = inner.child_by_field_name("body") {
                        this.visit_enum_body(body);
                    }
                }
            });
            return true;
        }

        self.create_node(
            "type_alias",
            &name,
            node,
            Extra {
                docstring,
                ..Extra::default()
            },
        );
        false
    }

    /// extractVariable: C takes the dedicated branch (file-scope declarators,
    /// tree-sitter.ts:2795); cpp takes the TS GENERIC fallback (direct
    /// identifier children).
    pub(super) fn extract_variable(&mut self, node: Node<'t>) {
        let is_const = self.variant == Variant::C && self.is_const_declaration(node);
        let kind: &'static str = if is_const { "constant" } else { "variable" };
        let docstring = preceding_docstring(node, self.src);
        // isExported?.() ?? false — EXPLICIT false (tri-state flag set).
        let is_exported = Some(false);

        if self.variant == Variant::C {
            if has_function_ancestor(node) {
                return;
            }
            for child in named_children(node) {
                if !matches!(
                    child.kind(),
                    "init_declarator" | "pointer_declarator" | "array_declarator"
                ) {
                    continue;
                }
                let Some(name_node) = c_declarator_identifier(child) else {
                    continue;
                };
                let name = self.text(name_node);
                if name.is_empty() {
                    continue;
                }
                let value_node = if child.kind() == "init_declarator" {
                    child.child_by_field_name("value")
                } else {
                    None
                };
                let signature = value_node.map(|v| util::init_signature(self.text(v)));
                self.create_node(
                    kind,
                    name,
                    child,
                    Extra {
                        docstring: docstring.clone(),
                        signature,
                        is_exported,
                        ..Extra::default()
                    },
                );
            }
        } else {
            // Generic fallback: direct identifier children only (`int x;`
            // extracts; `int x = 5;` nests in an init_declarator and does not).
            for child in named_children(node) {
                if child.kind() != "identifier" {
                    continue;
                }
                let name = self.text(child).to_string();
                if !name.is_empty() && name != "<anonymous>" {
                    self.create_node(
                        kind,
                        &name,
                        child,
                        Extra {
                            docstring: docstring.clone(),
                            is_exported,
                            ..Extra::default()
                        },
                    );
                }
            }
        }
    }
}
