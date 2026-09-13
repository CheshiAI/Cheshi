//! walker for the php extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref(
        &mut self,
        from_row: u32,
        name: &str,
        kind_code: u8,
        line: u32,
        column: u32,
    ) {
        util::emit_state_ref(&mut self.state, from_row, name, kind_code, line, column);
    }

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
        util::emit_recorded_node_row(
            &mut self.state,
            kind,
            name,
            node,
            extra,
            matches!(kind, "function" | "method"),
        )
    }

    pub(super) fn extract_name(&self, node: Node) -> String {
        util::declaration_name(node, self.src).unwrap_or_else(|| "<anonymous>".to_string())
    }

    // --- hooks (languages/php.ts) ------------------------------------------------

    /// getVisibility: any `visibility_modifier` child with one of the three
    /// texts; none → public (the php default).
    pub(super) fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() == "visibility_modifier" {
                match self.text(child) {
                    "public" => return 1,
                    "private" => return 2,
                    "protected" => return 3,
                    _ => {}
                }
            }
        }
        1 // PHP defaults to public
    }

    pub(super) fn is_static(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "static_modifier")
    }

    /// extractPhpReturnType — `self`/`static` collapse to the `'self'` marker
    /// (#608 chained-call fuel); primitives/unions → None.
    pub(super) fn return_type_of(&self, node: Node) -> Option<String> {
        let mut rt = node.child_by_field_name("return_type")?;
        if rt.kind() == "optional_type" {
            rt = rt.named_child(0).unwrap_or(rt);
        }
        if rt.kind() == "primitive_type" {
            return None;
        }
        let name_node = if rt.kind() == "named_type" {
            rt.named_child(0).unwrap_or(rt)
        } else {
            rt
        };
        let text = self.text(name_node).trim();
        let text = text.strip_prefix('\\').unwrap_or(text);
        if text.is_empty() {
            return None;
        }
        let last = text.rsplit('\\').next().unwrap_or(text);
        let lc = last.to_lowercase();
        if matches!(lc.as_str(), "self" | "static" | "this" | "$this") {
            return Some("self".to_string());
        }
        if is_php_non_class_return(&lc) {
            return None;
        }
        if !ascii_ident_re().is_match(last) {
            return None; // unions/intersections/complex
        }
        Some(last.to_string())
    }

    // --- the visitNode hook (php.ts:108) ------------------------------------------

    pub(super) fn try_visit_hook(&mut self, node: Node<'t>) -> bool {
        match node.kind() {
            // Class/interface/trait/enum/top-level constants: one `constant`
            // node per const_element, NO extras, values never walked.
            "const_declaration" => {
                let elements: Vec<Node> = (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i))
                    .filter(|c| c.kind() == "const_element")
                    .collect();
                for elem in elements {
                    let name_node = (0..elem.named_child_count())
                        .filter_map(|i| elem.named_child(i))
                        .find(|c| c.kind() == "name");
                    let Some(name_node) = name_node else { continue };
                    let name = self.text(name_node).to_string();
                    self.create_node("constant", &name, elem, Extra::default());
                }
                true
            }
            // Trait use inside a class-like body: one `implements` ref per
            // used name (full qualified text), all at the use_declaration's
            // position — WITH filePath (the hook sets ctx.filePath; v2 flag).
            "use_declaration" => {
                let names: Vec<Node> = (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i))
                    .filter(|c| matches!(c.kind(), "name" | "qualified_name"))
                    .collect();
                let parent = self.top_row();
                let implements = edge_kind_index("implements").unwrap();
                for n in names {
                    let name = self.text(n).to_string();
                    util::emit_state_ref_flagged(
                        &mut self.state,
                        parent,
                        &name,
                        implements,
                        node,
                        REF_FLAG_FILE_PATH,
                    );
                }
                true
            }
            _ => false,
        }
    }

    // --- the dispatcher (visitNode, PHP-relevant branches) ------------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        if self.try_visit_hook(node) {
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_definition" {
            // functionTypes; method_declaration is not in it, so this is
            // always extractFunction (php functions can't be class members).
            self.extract_function(node);
            skip_children = true;
        } else if kind == "class_declaration" {
            self.extract_class(node, "class");
            skip_children = true;
        } else if kind == "trait_declaration" {
            // classifyClassNode → 'trait'.
            self.extract_class(node, "trait");
            skip_children = true;
        } else if kind == "method_declaration" {
            // Inside a class-like → method; outside (an anonymous class's
            // members at TOP level — grammar-bump delta #1) the 1747 gate
            // bounces to extractFunction: a file-level `function` node.
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "interface_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "property_declaration" && self.inside_class_like() {
            self.extract_field(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if matches!(
            kind,
            "namespace_use_declaration"
                | "include_expression"
                | "include_once_expression"
                | "require_expression"
                | "require_once_expression"
        ) {
            self.extract_import(node);
            // children still visited (importTypes sets no skipChildren)
        } else if matches!(
            kind,
            "function_call_expression" | "member_call_expression" | "scoped_call_expression"
        ) {
            self.extract_call(node);
        } else if kind == "object_creation_expression" && self.extract_object_creation(node) {
            skip_children = true;
        }
        // text / php_tag / text_interpolation / namespace_definition /
        // nullsafe_member_call_expression / expression_statement / closures /
        // match / attributes: no branch — children visited.

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    // --- visitFunctionBody --------------------------------------------------------

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if matches!(
            kind,
            "function_call_expression" | "member_call_expression" | "scoped_call_expression"
        ) {
            self.extract_call(node);
        } else if kind == "object_creation_expression" && self.extract_object_creation(node) {
            return;
        }

        // Static value reads (`Cls::CONST`, `Cls::$prop`, `Cls::class`).
        self.extract_static_member_ref(node);

        // Nested NAMED functions; body-level class/trait/enum/interface
        // declarations (the polyfill idiom). NOTE: no method_declaration
        // branch — in-body anonymous-class methods vanish (delta #1), and the
        // visitNode hook does NOT run here (a const_declaration in a body-level
        // class still extracts via extractClass's own visitNode body walk).
        if kind == "function_definition" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_declaration" {
            self.extract_class(node, "class");
            return;
        }
        if kind == "trait_declaration" {
            self.extract_class(node, "trait");
            return;
        }
        if kind == "enum_declaration" {
            self.extract_enum(node);
            return;
        }
        if kind == "interface_declaration" {
            self.extract_interface(node);
            return;
        }

        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }

    pub(super) fn visit_scoped_body(
        &mut self,
        node: Node<'t>,
        row: u32,
        kind: &'static str,
        name: String,
    ) {
        let body = node.child_by_field_name("body").unwrap_or(node);
        self.with_scope(row, kind, name, |walker| {
            for child in util::named_children(body) {
                walker.visit_node(child);
            }
        });
    }

    // --- imports -------------------------------------------------------------------

    /// pushPhpUseRef (3563): `Foo\Bar\Baz` → an `imports` ref named
    /// `Foo\Bar::Baz`; a global-namespace name (no `\` after stripping one
    /// leading `\`) emits nothing here.
    pub(super) fn push_php_use_ref(&mut self, fqn: &str, from_row: u32, node: Node) {
        let clean = fqn.strip_prefix('\\').unwrap_or(fqn);
        let Some(last_sep) = clean.rfind('\\') else {
            return;
        };
        let name = format!("{}::{}", &clean[..last_sep], &clean[last_sep + 1..]);
        self.push_ref_at(from_row, &name, edge_kind_index("imports").unwrap(), node);
    }

    pub(super) fn walk_php_type_position(&mut self, node: Node<'t>, from_row: u32) {
        match node.kind() {
            "primitive_type" => {}
            "name" => {
                let name = self.text(node);
                if !name.is_empty() && !is_php_pseudo_type(name) {
                    self.push_ref_at(from_row, name, edge_kind_index("references").unwrap(), node);
                }
            }
            "qualified_name" => {
                let text = self.text(node);
                let last = text.rsplit('\\').next().unwrap_or("");
                if !last.is_empty() && !is_php_pseudo_type(last) {
                    self.push_ref_at(from_row, last, edge_kind_index("references").unwrap(), node);
                }
            }
            _ => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        self.walk_php_type_position(c, from_row);
                    }
                }
            }
        }
    }

    /// phpStringContent: the string's first string_content child, trimmed.
    pub(super) fn php_string_content(&self, node: Node) -> Option<String> {
        for i in 0..node.named_child_count() {
            let Some(c) = node.named_child(i) else {
                continue;
            };
            if c.kind() == "string_content" {
                return Some(self.text(c).trim().to_string());
            }
        }
        None
    }
}
