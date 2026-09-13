//! walker for the swift extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
    }

    // --- createNode ------------------------------------------------------------

    pub(super) fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        let row = util::emit_node_row(&mut self.state, kind, name, node, extra)?;

        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        // captureValueRefScope — struct:/enum: parents accepted (the swift
        // static-let-namespacing idiom).
        if util::captures_value_ref_target(kind, name, self.stack.last().map(|scope| scope.kind)) {
            let state = &mut self.state;
            util::record_value_ref_target(
                &mut state.fs_values,
                &mut state.fs_value_counts,
                name,
                row,
            );
        }
        if matches!(kind, "function" | "method" | "constant" | "variable") {
            self.value_scopes.push(ValueScope {
                row,
                node,
                name: name.to_string(),
            });
        }
        Some(row)
    }

    // --- hooks (languages/swift.ts) ----------------------------------------------

    /// extractName incl. the resolveName hook: a multi-segment extension name
    /// (`extension KF.Builder`) takes the LAST type_identifier's text.
    pub(super) fn extract_name(&self, node: Node) -> String {
        if node.kind() == "class_declaration" {
            if let Some(name_node) = node.child_by_field_name("name") {
                if name_node.kind() == "user_type" {
                    let ids: Vec<Node> = util::named_children(name_node)
                        .filter(|c| c.kind() == "type_identifier")
                        .collect();
                    if ids.len() > 1 {
                        return self.text(ids[ids.len() - 1]).to_string();
                    }
                }
            }
        }
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if let Some(c) = util::first_named_child_kind_any(
            node,
            &[
                "identifier",
                "type_identifier",
                "simple_identifier",
                "constant",
            ],
        ) {
            return self.text(c).to_string();
        }
        "<anonymous>".to_string()
    }

    /// getVisibility: whole-text substring matching over `modifiers` children;
    /// default INTERNAL. `open` → internal, `fileprivate` → private (via the
    /// 'private' substring), `public private(set)` → public (first match).
    pub(super) fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() != "modifiers" {
                continue;
            }
            let text = self.text(child);
            if text.contains("public") {
                return 1;
            }
            if text.contains("private") {
                return 2;
            }
            if text.contains("internal") {
                return 4;
            }
            // 'fileprivate' arm is dead — 'private' already matched.
        }
        4 // Swift defaults to internal
    }

    pub(super) fn modifier_contains(&self, node: Node, needle: &str) -> bool {
        (0..node.child_count())
            .filter_map(|index| node.child(index))
            .any(|child| child.kind() == "modifiers" && self.text(child).contains(needle))
    }

    /// isStatic: modifiers text contains 'static' OR 'class' (class members
    /// count — deliberate; substring semantics preserved).
    pub(super) fn is_static(&self, node: Node) -> bool {
        self.modifier_contains(node, "static") || self.modifier_contains(node, "class")
    }

    /// isAsync: dead hook — `async` never sits inside `modifiers` (it's an
    /// anon child after the params) → effectively always false, but PRESENT.
    pub(super) fn is_async(&self, node: Node) -> bool {
        self.modifier_contains(node, "async")
    }

    /// extractSwiftReturnType — POSITIONAL: first user_type/optional_type after
    /// the name simple_identifier, before function_body; last dotted segment;
    /// generics stripped non-nesting; Void → None.
    pub(super) fn return_type_of(&self, node: Node) -> Option<String> {
        let mut seen_name = false;
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            if child.kind() == "simple_identifier" && !seen_name {
                seen_name = true;
                continue;
            }
            if !seen_name {
                continue;
            }
            if child.kind() == "function_body" {
                return None;
            }
            let type_node = match child.kind() {
                "user_type" => Some(child),
                "optional_type" => util::first_named_child_kind(child, "user_type"),
                _ => None,
            };
            if child.kind() == "user_type" || child.kind() == "optional_type" {
                let t = type_node?;
                let name = util::strip_non_nested_generic_args(self.text(t).trim());
                let last = name.rsplit('.').next().unwrap_or("").trim();
                if last.is_empty() || !util::is_ascii_identifier(last) || last == "Void" {
                    return None;
                }
                return Some(last.to_string());
            }
        }
        None
    }

    /// swiftPropertyInfo (tree-sitter.ts:277).
    pub(super) fn swift_property_info(&self, node: Node<'t>) -> SwiftPropInfo<'t> {
        let children: Vec<Node<'t>> = util::named_children(node).collect();
        let pattern = node.child_by_field_name("name").or_else(|| {
            children
                .iter()
                .copied()
                .find(|child| matches!(child.kind(), "value_binding_pattern" | "pattern"))
        });
        let binding = children
            .iter()
            .copied()
            .find(|child| child.kind() == "value_binding_pattern");
        let is_let = binding
            .map(|b| self.text(b).trim_start().starts_with("let"))
            .unwrap_or(false);
        let is_computed = children.iter().any(|child| {
            matches!(
                child.kind(),
                "computed_property" | "protocol_property_requirements"
            )
        });
        SwiftPropInfo {
            name_node: first_simple_identifier(pattern),
            is_let,
            is_computed,
        }
    }

    pub(super) fn classify_declaration(node: Node) -> &'static str {
        if util::has_child_kind(node, "struct") {
            "struct"
        } else if util::has_child_kind(node, "enum") {
            "enum"
        } else {
            "class"
        }
    }

    pub(super) fn declaration_extra(&self, node: Node<'t>) -> Extra {
        Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        }
    }

    pub(super) fn docstring_extra(&self, node: Node<'t>) -> Extra {
        Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
        }
    }

    pub(super) fn member_extra(&self, node: Node<'t>, is_static: bool) -> Extra {
        Extra {
            visibility: Some(self.visibility_of(node)),
            is_static: Some(is_static),
            ..Extra::default()
        }
    }

    pub(super) fn visit_named_children(&mut self, node: Node<'t>) {
        for child in util::named_children(node) {
            self.visit_node(child);
        }
    }

    pub(super) fn visit_body_children(&mut self, node: Node<'t>) {
        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }

    pub(super) fn visit_scope_body(
        &mut self,
        body: Node<'t>,
        row: u32,
        kind: &'static str,
        name: String,
    ) {
        self.with_scope(row, kind, name, |walker| walker.visit_named_children(body));
    }

    // --- the dispatcher (visitNode, Swift-relevant branches) -----------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_declaration" {
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "class_declaration" {
            // classifyClassNode: `struct`/`enum` keyword children; actor and
            // extension fall through to 'class'.
            self.visit_class_like_declaration(node);
            skip_children = true;
        } else if kind == "protocol_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "typealias_declaration" {
            skip_children = self.extract_type_alias(node);
        } else if kind == "property_declaration" && !self.inside_class_like() {
            // Top-level let/var (extractVariable's swift branch). Initializers
            // are NEVER walked — candidates-only scan.
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if matches!(
            kind,
            "property_declaration" | "protocol_property_declaration"
        ) && self.inside_class_like()
        {
            skip_children = self.dedicated_property_branch(node);
        } else if kind == "import_declaration" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        }
        // init/deinit/subscript declarations, macro_invocation, directive,
        // diagnostic, operator/precedence declarations, protocol function
        // requirements, associatedtype: no branch — recursed. Their calls
        // attribute to the enclosing scope; static-member reads inside them
        // emit NOTHING (the pass is body-walker-only).

        if !skip_children {
            self.visit_named_children(node);
        }
    }

    pub(super) fn walk_attr_args(&mut self, n: Node<'t>) {
        self.extract_static_member_ref(n);
        for c in util::named_children(n) {
            self.walk_attr_args(c);
        }
    }

    // --- visitFunctionBody ---------------------------------------------------------

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        }
        // (INSTANTIATION_KINDS has no swift types; extractBareCall absent.)

        self.extract_static_member_ref(node);

        if kind == "function_declaration" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_declaration" {
            self.visit_class_like_declaration(node);
            return;
        }
        if kind == "protocol_declaration" {
            self.extract_interface(node);
            return;
        }

        self.visit_body_children(node);
    }
}
