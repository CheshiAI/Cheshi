//! walker for the kotlin extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
    }

    /// resolveBody (kotlin.ts:219): first ERROR child whose child(0) is `{`
    /// (fun-interface parent body — unreachable post-defer, kept for
    /// contract), else first function_body | class_body | enum_class_body.
    pub(super) fn resolve_body(&self, node: Node<'t>) -> Option<Node<'t>> {
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            if child.kind() == "ERROR" {
                if let Some(first) = child.child(0) {
                    if first.kind() == "{" {
                        return Some(child);
                    }
                }
            }
            if matches!(
                child.kind(),
                "function_body" | "class_body" | "enum_class_body"
            ) {
                return Some(child);
            }
        }
        None
    }

    // --- createNode ------------------------------------------------------------

    pub(super) fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        mut extra: Extra,
    ) -> Option<u32> {
        // extractModifiers merge (tree-sitter.ts:1355) — runs for EVERY
        // created node: expect/actual platform modifiers → decorators.
        extra.decorators = self.extract_modifiers(node);
        if kind == "function" || kind == "method" {
            let body_end = self
                .resolve_body(node)
                .map(|body| body.end_position().row as u32 + 1)
                .unwrap_or(0);
            extra.end_line = Some(body_end.max(node.end_position().row as u32 + 1));
        }
        let row = util::emit_recorded_node_row(
            &mut self.state,
            kind,
            name,
            node,
            extra,
            matches!(kind, "function" | "method"),
        )?;
        self.nodes_meta.push(NodeMeta {
            kind,
            name: name.to_string(),
        });
        Some(row)
    }

    // --- hooks (languages/kotlin.ts) ----------------------------------------------

    /// extractName — the zero-field grammar means the nameField lookup always
    /// misses; names come from the shared fallback scan (first direct
    /// identifier-family child; backtick names keep their backticks).
    pub(super) fn extract_name(&self, node: Node) -> String {
        if let Some(name_node) = node.child_by_field_name("simple_identifier") {
            // nameField is a TYPE name used as a FIELD name — never resolves
            // (mirrored for shape; the grammar has zero fields).
            return self.text(name_node).to_string();
        }
        util::first_named_child_kind_any(
            node,
            &[
                "identifier",
                "type_identifier",
                "simple_identifier",
                "constant",
            ],
        )
        .map(|child| self.text(child).to_string())
        .unwrap_or_else(|| "<anonymous>".to_string())
    }

    /// classifyClassNode: the Kotlin grammar exposes `interface`/`enum` as
    /// unnamed keyword children. Keep the child-order precedence in one place
    /// so the two walkers cannot drift apart.
    pub(super) fn class_kind(&self, node: Node) -> &'static str {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.kind() == "interface" {
                    return "interface";
                }
                if child.kind() == "enum" {
                    return "enum";
                }
            }
        }
        "class"
    }

    /// getVisibility: modifiers text includes public/private/protected/
    /// internal in that order; default PUBLIC. Text-includes semantics —
    /// annotation text inside modifiers can flip it (bug-for-bug).
    pub(super) fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() == "modifiers" {
                let text = self.text(child);
                if text.contains("public") {
                    return 1;
                }
                if text.contains("private") {
                    return 2;
                }
                if text.contains("protected") {
                    return 3;
                }
                if text.contains("internal") {
                    return 4;
                }
            }
        }
        1 // Kotlin defaults to public
    }

    /// isAsync: modifiers text includes 'suspend' (text-includes false
    /// positive on `@suspendMarker` annotations — preserve).
    pub(super) fn is_async(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "modifiers" && self.text(c).contains("suspend"))
    }

    /// extractKotlinReturnType — positional: the first user_type/nullable_type
    /// AFTER function_value_parameters; function_body/type_constraints first →
    /// None; Unit/Nothing → None; `: T` generic params leak (preserve).
    pub(super) fn return_type_of(&self, node: Node) -> Option<String> {
        let mut seen_params = false;
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            if child.kind() == "function_value_parameters" {
                seen_params = true;
                continue;
            }
            if !seen_params {
                continue;
            }
            if matches!(child.kind(), "function_body" | "type_constraints") {
                return None;
            }
            if matches!(child.kind(), "user_type" | "nullable_type") {
                let ut = if child.kind() == "nullable_type" {
                    (0..child.named_child_count())
                        .filter_map(|j| child.named_child(j))
                        .find(|c| c.kind() == "user_type")
                        .unwrap_or(child)
                } else {
                    child
                };
                let type_id = (0..ut.named_child_count())
                    .filter_map(|j| ut.named_child(j))
                    .find(|c| c.kind() == "type_identifier");
                let name = self.text(type_id.unwrap_or(ut)).trim();
                if name.is_empty() || !ascii_ident_re().is_match(name) {
                    return None;
                }
                if matches!(name, "Unit" | "Nothing") {
                    return None;
                }
                return Some(name.to_string());
            }
        }
        None
    }

    /// getReceiverType — extension functions: the last user_type BEFORE a `.`
    /// child; its FIRST type_identifier's text (qualified receivers take the
    /// FIRST segment — the `com::qext` bug, preserve).
    pub(super) fn receiver_type_of(&self, node: Node<'t>) -> Option<String> {
        let mut found_user_type: Option<Node> = None;
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            match child.kind() {
                "user_type" => found_user_type = Some(child),
                "." => {
                    if let Some(ut) = found_user_type {
                        let type_id = (0..ut.named_child_count())
                            .filter_map(|j| ut.named_child(j))
                            .find(|c| c.kind() == "type_identifier");
                        return Some(self.text(type_id.unwrap_or(ut)).to_string());
                    }
                }
                "simple_identifier" | "function_value_parameters" => break,
                _ => {}
            }
        }
        None
    }

    /// extractModifiers — expect/actual platform modifiers, matched by NODE
    /// TYPE (never text), in order. Runs inside create_node for every node.
    pub(super) fn extract_modifiers(&self, node: Node) -> Option<Vec<String>> {
        let mut mods: Vec<String> = Vec::new();
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() != "modifiers" {
                continue;
            }
            for j in 0..child.child_count() {
                let Some(pm) = child.child(j) else { continue };
                if pm.kind() != "platform_modifier" {
                    continue;
                }
                for k in 0..pm.child_count() {
                    let Some(kw) = pm.child(k) else { continue };
                    if matches!(kw.kind(), "expect" | "actual") {
                        mods.push(kw.kind().to_string());
                    }
                }
            }
        }
        if mods.is_empty() {
            None
        } else {
            Some(mods)
        }
    }

    // --- the visitNode hook (property branch ONLY — fun-interface recovery is
    // defer-shielded and not ported) ------------------------------------------------

    pub(super) fn try_visit_hook(&mut self, node: Node<'t>) -> bool {
        if node.kind() != "property_declaration" {
            return false;
        }
        let var_decl = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "variable_declaration");
        let name_node = var_decl.and_then(|vd| {
            (0..vd.named_child_count())
                .filter_map(|i| vd.named_child(i))
                .find(|c| c.kind() == "simple_identifier")
        });
        let Some(name_node) = name_node else {
            return false;
        }; // destructuring → decline
        let name = self.text(name_node).to_string();
        if name.is_empty() {
            return false;
        }

        // Scope walk up the parent chain — first match wins.
        let mut scope: &str = "const";
        let mut p = node.parent();
        while let Some(pn) = p {
            match pn.kind() {
                "function_body"
                | "function_declaration"
                | "lambda_literal"
                | "anonymous_initializer"
                | "control_structure_body"
                | "getter"
                | "setter" => {
                    scope = "local";
                    break;
                }
                "companion_object" | "object_declaration" => {
                    scope = "const";
                    break;
                }
                "class_declaration" => {
                    scope = "instance";
                    break;
                }
                _ => {}
            }
            p = pn.parent();
        }
        if scope == "local" {
            return true; // a local — extract nothing, subtree still scanned
        }

        let binding = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "binding_pattern_kind");
        let is_val = binding.map(|b| self.text(b) == "val").unwrap_or(false);
        let kind: &'static str = if scope == "instance" {
            "field"
        } else if is_val {
            "constant"
        } else {
            "variable"
        };
        // The `type`-field signature read is dead (zero fields) → signature
        // undefined; NO docstring/visibility/isStatic — the modifiers merge in
        // create_node still decorates expect/actual properties.
        self.create_node(kind, &name, node, Extra::default());
        true
    }

    // --- the dispatcher (visitNode, Kotlin-relevant branches) -----------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        if self.try_visit_hook(node) {
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

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
            // classifyClassNode: `interface`/`enum` keyword children.
            match self.class_kind(node) {
                "interface" => self.extract_interface(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            skip_children = true;
        } else if kind == "object_declaration" {
            // extraClassNodeTypes → extractClass → kind `class`.
            self.extract_class(node);
            skip_children = true;
        } else if kind == "type_alias" {
            skip_children = self.extract_type_alias(node);
        } else if kind == "property_declaration" {
            // Hook-declined destructuring: extractField/extractVariable both
            // find no matching children for kotlin — NOTHING minted, RHS
            // invisible; candidates-only scan.
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_header" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        }
        // companion_object, anonymous_initializer, secondary_constructor,
        // getter/setter siblings, file_annotation, object_literal, if/when at
        // top level: no branch — recursed (calls attribute to the stack top).

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    // --- visitFunctionBody ----------------------------------------------------------

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        }
        // (INSTANTIATION_KINDS has no kotlin members; extractBareCall absent.)

        self.extract_static_member_ref(node);

        if kind == "function_declaration" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                // extractFunction diverts receiver-bearing nested fns to
                // extractMethod itself.
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_declaration" {
            match self.class_kind(node) {
                "interface" => self.extract_interface(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            return;
        }
        // object_declaration is NOT dispatched here — a body-local object's
        // `fun`s hit the function branch above and leak out as FUNCTIONS
        // under the enclosing fn; its properties mint nothing (quirk).

        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }
}
