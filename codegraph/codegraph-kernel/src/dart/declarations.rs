//! declarations for the dart extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractFunction / extractMethod (:1517 / :1737) ------------------

    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        // No receiver hook. Name first (resolveName inside extract_name).
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            // :1549 — body-only walk (nothing pushed). Dart signatures always
            // name; preserved for fidelity.
            if let Some(body) = self.resolve_body(node) {
                self.visit_body(body);
            }
            return;
        }
        // isMisparsedFunction: the unnamed constructor is skipped — node
        // suppressed, body still walked (attributed to the current stack top).
        if self.is_unnamed_ctor(node) {
            if let Some(body) = self.resolve_body(node) {
                self.visit_body(body);
            }
            return;
        }
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_async = self.is_async_of(node);
        let is_static = self.is_static_of(node);
        let return_type = self.return_type_of(node);
        let body = self.resolve_body(node);
        let end_line_override = body.map(|b| b.end_position().row as u32 + 1);
        let row = self.create_node(
            "function",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_async: Some(is_async),
                is_static: Some(is_static),
                return_type,
                end_line_override,
            },
        );
        let Some(row) = row else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope {
            row,
            kind: "function",
            name,
        });
        if let Some(body) = body {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        // Gate (:1747): not inside class-like (no methodsAreTopLevel, no
        // receiver, parent never object/object_expression) → extractFunction.
        if !self.inside_class_like() {
            self.extract_function(node);
            return;
        }
        let name = self.extract_name(node);
        // isMisparsedFunction — the unnamed ctor: body-only walk.
        if self.is_unnamed_ctor(node) {
            if let Some(body) = self.resolve_body(node) {
                self.visit_body(body);
            }
            return;
        }
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_async = self.is_async_of(node);
        let is_static = self.is_static_of(node);
        let return_type = self.return_type_of(node);
        let body = self.resolve_body(node);
        let end_line_override = body.map(|b| b.end_position().row as u32 + 1);
        // Operators mint method "<anonymous>" — extractMethod has NO skip.
        let row = self.create_node(
            "method",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_async: Some(is_async),
                is_static: Some(is_static),
                return_type,
                end_line_override,
            },
        );
        let Some(row) = row else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope {
            row,
            kind: "method",
            name,
        });
        if let Some(body) = body {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    // --- extractClass (:1679) — classes, mixins, extensions ---------------

    pub(super) fn extract_class(&mut self, node: Node<'t>) {
        let resolved_body = self.resolve_body(node);
        // No skipBodilessClass. Anonymous `extension on String` → the name
        // fallback finds the ON type's type_identifier — a class named after
        // the extended type (preserved).
        let name = self.extract_name(node);
        let docstring = preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "class",
            &name,
            node,
            Extra {
                docstring,
                visibility,
                ..Default::default()
            },
        );
        let Some(row) = row else { return };
        self.extract_inheritance(node, row);
        // extractCsharpPrimaryCtorParamRefs — csharp-gated no-op.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope {
            row,
            kind: "class",
            name,
        });
        let body = resolved_body.unwrap_or(node);
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
        self.stack.pop();
    }

    // --- extractEnum (:1914) ----------------------------------------------

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let body = match self.resolve_body(node) {
            Some(b) => b,
            None => return,
        };
        let name = self.extract_name(node);
        let docstring = preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "enum",
            &name,
            node,
            Extra {
                docstring,
                visibility,
                ..Default::default()
            },
        );
        let Some(row) = row else { return };
        // Enum `with` mixins are a DIRECT child (no superclass wrapper) →
        // no clause matches; `interfaces` DOES → implements only.
        self.extract_inheritance(node, row);
        // No extractDecoratorsFor on the enum path.
        self.stack.push(Scope {
            row,
            kind: "enum",
            name,
        });
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            if child.kind() == "enum_constant" {
                self.extract_enum_members(child);
            } else {
                self.visit(child);
            }
        }
        self.stack.pop();
    }

    /// extractEnumMembers (:1958) — one enum_member per constant, positioned
    /// at the enum_constant node; ctor arguments never walked.
    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    // --- extractTypeAlias (:2890, plain path) -----------------------------

    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring(node, self.src);
        // `value` field is null (type_alias has no fields) → no refs from
        // the aliased type; returns false → children re-visited.
        self.create_node(
            "type_alias",
            &name,
            node,
            Extra {
                docstring,
                ..Default::default()
            },
        );
        false
    }
}
