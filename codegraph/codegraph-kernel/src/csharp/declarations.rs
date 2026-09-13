//! declarations for the csharp extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractors --------------------------------------------------------------

    pub(super) fn extract_class(&mut self, node: Node<'t>) {
        // skipBodilessClass unset: a bodiless `record Empty;` still mints a node.
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default() // isExported hook absent → flag not present
        };
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.extract_primary_ctor_param_refs(node, row);
        // extractDecoratorsFor: C# attributes never match its accepted node
        // types (attribute_list is skipped, its children never reached) —
        // zero `decorates` refs; the call slot emits nothing.

        self.stack.push(Scope {
            row,
            kind: "class",
            name,
        });
        // body ?? node: a bodiless record's own children are iterated
        // "harmlessly" — visit_node on identifier/parameter_list/base_list
        // children falls through (base-arg identifiers still feed fn-ref
        // capture, mirroring the TS walk).
        let body = node.child_by_field_name("body").unwrap_or(node);
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        // no synthesizeMembers for C#
        self.stack.pop();
    }

    pub(super) fn extract_struct(&mut self, node: Node<'t>) {
        // Body gate — EXCEPT C# positional records (`record struct M(…);`,
        // node type record_declaration), complete definitions with no body.
        // A bodiless `struct Fwd;` mints NO node. (#831)
        let body = node.child_by_field_name("body");
        if body.is_none() && node.kind() != "record_declaration" {
            return;
        }
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("struct", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.extract_primary_ctor_param_refs(node, row);
        // NOTE: extractStruct does NOT call extractDecoratorsFor (TS parity).
        if let Some(body) = body {
            self.stack.push(Scope {
                row,
                kind: "struct",
                name,
            });
            for child in util::named_children(body) {
                self.visit_node(child);
            }
            self.stack.pop();
        }
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
        self.stack.push(Scope {
            row,
            kind: "interface",
            name,
        });
        let body = node.child_by_field_name("body").unwrap_or(node);
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        self.stack.pop();
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
        // The underlying type (`enum ReadType : byte`) sits in base_list →
        // an `extends` ref named `byte` (garbage, PRESERVE).
        self.extract_inheritance(node, row);
        self.stack.push(Scope {
            row,
            kind: "enum",
            name,
        });
        for child in util::named_children(body) {
            if child.kind() == "enum_member_declaration" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        // name-field path: one enum_member node positioned at the MEMBER node
        // (attributes included in its span); values/attributes ignored.
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = util::source_text(self.src, name_node).to_string();
        self.create_node("enum_member", &name, node, Extra::default());
        // (identifier-children / leaf fallbacks are other grammars' shapes)
    }

    /// extractProperty (1986) — property_declaration only (dispatch-gated to
    /// class-like scopes). Accessor bodies and `=>` value clauses are never
    /// walked; type refs DO come from the `type` field.
    pub(super) fn extract_property(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let visibility = Some(self.visibility_of(node));
        let is_static = Some(self.is_static(node)); // ?? false — always concrete

        let name_node = node
            .child_by_field_name("name")
            .or_else(|| node.child_by_field_name("property"))
            .or_else(|| util::first_named_child_kind(node, "identifier"));
        let Some(name_node) = name_node else { return };
        let name = util::source_text(self.src, name_node).to_string();
        if name.is_empty() {
            return;
        }

        // Generic scan (isTsJsField=false): FIRST namedChild that isn't a
        // modifier/name/accessor/initializer. A BARE-identifier declared type
        // (`public Widget Parent {get;}`) is excluded by the `identifier`
        // filter → the signature loses its type (QUIRK, preserve); the type
        // ref below still fires via the `type` FIELD.
        let type_node = util::named_children(node).find(|child| {
            !matches!(
                child.kind(),
                "modifier"
                    | "modifiers"
                    | "identifier"
                    | "accessor_list"
                    | "accessors"
                    | "equals_value_clause"
            )
        });
        let type_text = type_node.map(|t| {
            let raw = util::source_text(self.src, t);
            // TS `.replace(/^:\s*/, '')` — inert for C# type text; mirrored.
            match raw.strip_prefix(':') {
                Some(rest) => rest.trim_start_matches(util::is_js_whitespace).to_string(),
                None => raw.to_string(),
            }
        });
        let signature = match &type_text {
            Some(t) => format!("{t} {name}"),
            None => name.clone(),
        };

        let row = self.create_node(
            "property",
            &name,
            node,
            Extra {
                docstring,
                signature: Some(signature),
                visibility,
                is_static,
                ..Extra::default()
            },
        );
        // decorators: none for C#; then the csharp type-ref path.
        self.emit_type_refs_if_present(node, row);
    }

    /// extractField (2046) — field_declaration; each declarator becomes a
    /// field/constant node anchored at the DECLARATOR.
    pub(super) fn extract_field(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let visibility = Some(self.visibility_of(node));
        let is_static = Some(self.is_static(node));
        // `const` / `static readonly` → constant (value-ref targets).
        let field_kind: &'static str = if self.is_const(node) {
            "constant"
        } else {
            "field"
        };

        // Direct declarators (Java shape) — none for C#; the wrapper path:
        let mut declarators: Vec<Node> = util::named_children(node)
            .filter(|child| child.kind() == "variable_declarator")
            .collect();
        let var_decl = util::first_named_child_kind(node, "variable_declaration");
        if declarators.is_empty() {
            if let Some(vd) = var_decl {
                declarators = util::named_children(vd)
                    .filter(|child| child.kind() == "variable_declarator")
                    .collect();
            }
        }
        // (PHP property_element branch: unreachable for C#.)

        if !declarators.is_empty() {
            let type_search = var_decl.unwrap_or(node);
            let type_node = util::named_children(type_search).find(|child| {
                !matches!(
                    child.kind(),
                    "modifiers"
                        | "modifier"
                        | "variable_declarator"
                        | "variable_declaration"
                        | "marker_annotation"
                        | "annotation"
                )
            });
            let type_text = type_node.map(|t| util::source_text(self.src, t).to_string());

            for decl in declarators {
                let name_node = decl
                    .child_by_field_name("name")
                    .or_else(|| util::first_named_child_kind(decl, "identifier"));
                let Some(name_node) = name_node else { continue };
                let name = util::source_text(self.src, name_node).to_string();
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
                // decorators: none; type refs from the OUTER declaration —
                // multi-declarator fields emit the type refs once PER
                // declarator, each from its own field node.
                self.emit_type_refs_if_present(node, row);
            }
        } else {
            // Bare fallback (unreachable on non-erroring C#; ported for shape).
            let name_node = util::child_by_field_or_kind(node, "name", "identifier");
            if let Some(name_node) = name_node {
                let name = util::source_text(self.src, name_node).to_string();
                self.create_node(
                    field_kind,
                    &name,
                    node,
                    Self::bare_field_extra(docstring, visibility, is_static),
                );
            }
        }
    }

    /// extractMethod (1737) — method_declaration + constructor_declaration.
    /// Signature is ALWAYS undefined (no getSignature hook); isAsync is real.
    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        if !util::inside_class_like(&self.stack) {
            // Unreachable on non-erroring C# (top-level `void M(){}` parses as
            // local_function_statement; erroring files defer) — mirror the TS
            // treat-as-function tail for shape.
            self.extract_function(node);
            return;
        }
        let name = self.extract_name(node);
        let extra = self.function_extra(node);
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };
        // extractTypeAnnotations short-circuits into the csharp path:
        // `returns`-field refs FIRST, then per-parameter type refs.
        self.extract_csharp_type_refs(node, row);
        // decorators: none.
        self.stack.push(Scope {
            row,
            kind: "method",
            name,
        });
        // The `body` FIELD only (block or arrow_expression_clause). A
        // constructor_initializer (`: base(args)`) is NOT the body → its
        // argument calls are LOST (quirk, preserve).
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    /// extractFunction — only reachable for a method outside any class
    /// (unreachable on non-erroring C#; kept faithful to the generic tail).
    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = self.function_extra(node);
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };
        self.extract_csharp_type_refs(node, row);
        self.stack.push(Scope {
            row,
            kind: "function",
            name,
        });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    pub(super) fn extract_variable(&mut self, node: Node<'t>) {
        // extractVariable's generic fallback: direct identifier /
        // variable_declarator children only — C# nests declarators inside
        // variable_declaration, so this NEVER fires (`var x = F();` at top
        // level produces no node, no calls ref, no instantiates — preserve).
        let kind: &'static str = if self.is_const(node) {
            "constant"
        } else {
            "variable"
        };
        let docstring = preceding_docstring(node, self.src);
        for child in util::named_children(node) {
            let name = match child.kind() {
                "identifier" => util::source_text(self.src, child).to_string(),
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

    /// extractAnonymousClass — `new T() { ... }`. The C# grammar never
    /// produces a class_body/declaration_list child on object_creation
    /// (object initializers are initializer_expression), so this is
    /// unreachable — mirrored from the shared TS path like java.rs.
    pub(super) fn extract_anonymous_class(&mut self, node: Node<'t>, body: Node<'t>) {
        let type_node = util::child_by_fields(node, &["constructor", "type", "name"], 0);
        let mut type_name = type_node
            .map(|t| util::source_text(self.src, t).to_string())
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
        let anchor = type_node.unwrap_or(node);
        let line = anchor.start_position().row as u32;
        let column = util::node_column(self.src, &self.line_starts, anchor);
        self.push_ref(
            row,
            &type_name,
            edge_kind_index("extends").unwrap(),
            line,
            column,
        );

        self.stack.push(Scope {
            row,
            kind: "class",
            name: anon_name,
        });
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        self.stack.pop();
    }
}
