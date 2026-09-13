//! declarations for the kotlin extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractors ------------------------------------------------------------------

    pub(super) fn extract_function(&mut self, node: Node<'t>) {
        // getReceiverType short-circuit (1522) — extension fns at any scope.
        if self.receiver_type_of(node).is_some() {
            self.extract_method(node);
            return;
        }
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = self.resolve_body(node) {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None, // dead hook (zero fields)
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(false), // kotlin isStatic is always false
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };
        // extractTypeAnnotations: the generic path's field lookups all miss
        // (zero fields) — kotlin emits ZERO type-annotation refs.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope {
            row,
            kind: "function",
            name,
        });
        if let Some(body) = self.resolve_body(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        let receiver = self.receiver_type_of(node);
        let name = self.extract_name(node);
        let qualified_override = receiver.as_ref().map(|r| format!("{r}::{name}"));
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(false),
            return_type: self.return_type_of(node),
            qualified_name: qualified_override,
            ..Extra::default()
        };
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };
        // Owner-contains fallback (1799): receiver present, not class-like →
        // the FIRST same-file node named like the receiver with kind ∈
        // {struct, class, enum, trait} (interface EXCLUDED; source-order
        // dependent — both quirks preserved). Additive to the normal edge.
        if let Some(recv) = &receiver {
            if !self.inside_class_like() {
                let owner = util::first_row_matching(&self.nodes_meta, |meta| {
                    meta.name == *recv && matches!(meta.kind, "struct" | "class" | "enum" | "trait")
                });
                if let Some(owner_row) = owner {
                    util::emit_contains_edge(&mut self.state.tables, owner_row, row);
                }
            }
        }
        // Type annotations: dead. Decorators: live.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope {
            row,
            kind: "method",
            name,
        });
        if let Some(body) = self.resolve_body(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    pub(super) fn extract_class(&mut self, node: Node<'t>) {
        let resolved_body = self.resolve_body(node);
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        // primaryCtor refs: csharp-gated no-op.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope {
            row,
            kind: "class",
            name,
        });
        // Bodied: ONLY class_body children (primary-ctor properties/defaults
        // invisible). Bodiless: the class node itself → header children
        // visited → ctor default-value + super-arg calls attribute to the
        // CLASS (the asymmetry, pinned).
        let body = resolved_body.unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    pub(super) fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default() // NO visibility
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
        let body = self.resolve_body(node).unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = self.resolve_body(node) else {
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
        self.extract_inheritance(node, row);
        self.stack.push(Scope {
            row,
            kind: "enum",
            name,
        });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else {
                continue;
            };
            if child.kind() == "enum_entry" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        // name field → null (zero fields) → the identifier-children scan: one
        // enum_member per direct simple_identifier, positioned AT the
        // identifier. Entry value_arguments and entry class_bodies (override
        // methods!) are never visited — invisible (quirk).
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            if matches!(
                child.kind(),
                "simple_identifier" | "identifier" | "property_identifier"
            ) {
                let name = self.text(child).to_string();
                self.create_node("enum_member", &name, child, Extra::default());
            }
        }
    }

    /// extractTypeAlias — plain node; the alias-value ref walk reads the
    /// `value` FIELD → null (zero fields) → NO refs. Returns false →
    /// children re-visited (harmless).
    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
        };
        self.create_node("type_alias", &name, node, extra);
        false
    }
}
