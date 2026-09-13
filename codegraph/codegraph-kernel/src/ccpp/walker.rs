//! walker for the ccpp/mod extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_edge(
        &mut self,
        source_idx: u32,
        target_idx: u32,
        kind: u8,
        metadata_json: StrRef,
    ) {
        self.tables
            .push_edge(&EdgeRow::new(source_idx, target_idx, kind, metadata_json));
    }

    pub(super) fn push_ref_row(
        &mut self,
        from_idx: u32,
        kind: u8,
        line: u32,
        column: u32,
        reference_name: StrRef,
    ) {
        self.tables
            .push_ref(&RefRow::new(from_idx, kind, line, column, reference_name));
    }

    pub(super) fn with_scope<F>(&mut self, row: u32, kind: &'static str, name: String, visit: F)
    where
        F: FnOnce(&mut Self),
    {
        self.stack.push(Scope { row, kind, name });
        visit(self);
        self.stack.pop();
    }

    pub(super) fn visit_children(&mut self, node: Node<'t>) {
        for child in named_children(node) {
            self.visit_node(child);
        }
    }

    pub(super) fn visit_enum_body(&mut self, body: Node<'t>) {
        for child in named_children(body) {
            if child.kind() == "enumerator" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
    }

    pub(super) fn visit_call_children(&mut self, node: Node<'t>) {
        for child in named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }

    pub(super) fn declaration_extra(&self, node: Node) -> Extra {
        Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: (self.variant == Variant::Cpp)
                .then(|| self.visibility_of(node))
                .flatten(),
            ..Extra::default()
        }
    }

    pub(super) fn owner_row_for_type(&self, name: &str) -> Option<u32> {
        self.nodes_meta
            .iter()
            .position(|meta| {
                meta.name == name && matches!(meta.kind, "struct" | "class" | "enum" | "trait")
            })
            .map(|index| index as u32)
    }

    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        let name_ref = self.arena.put(name);
        self.push_ref_row(
            from_row,
            kind_code,
            self.line_of(node),
            self.col_of(node),
            name_ref,
        );
        if kind_code == edge_kind_index("imports").unwrap() {
            util::record_import_name(&mut self.imported_names, name);
        }
    }

    pub(super) fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        // (c/cpp define no resolveBody hook, so createNode's endLine extension
        // for sibling-body grammars never fires — endLine is the node's own.)
        let mut extra = extra;
        let qualified = extra.qualified_name.take().unwrap_or_else(|| {
            let parts = self.namespace_prefix.iter().map(String::as_str).chain(
                self.stack
                    .iter()
                    .filter(|scope| scope.kind != "file")
                    .map(|scope| scope.name.as_str()),
            );
            util::join_qualified_name(parts, name)
        });

        extra.qualified_name = Some(qualified);
        let row = self.store_node_row(kind, name, node, extra)?;
        self.nodes_meta.push(NodeMeta {
            kind,
            name: name.to_string(),
        });

        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        // captureValueRefScope (capture is variant-agnostic like the TS side;
        // flushValueRefs gates on the language — C only).
        let parent_kind = self.stack.last().map(|scope| scope.kind);
        if util::captures_value_ref_target(kind, name, parent_kind) {
            util::record_value_ref_target(
                &mut self.fs_values,
                &mut self.fs_value_counts,
                name,
                row,
            );
        }
        if util::is_value_ref_scope_node(kind) {
            self.value_scopes.push(ValueScope {
                row,
                node,
                name: name.to_string(),
            });
        }
        Some(row)
    }

    // --- name extraction -----------------------------------------------------

    /// extractName: extractNameRaw + the universal recoverMangledName net
    /// (wired for BOTH c and cpp in languages/c-cpp.ts).
    pub(super) fn extract_name(&self, node: Node) -> String {
        recover_mangled_cpp_name(self.extract_name_raw(node))
    }

    /// extractNameRaw for the c/cpp extractor configs (nameField 'declarator';
    /// cpp resolveName = extractCppQualifiedMethodName).
    pub(super) fn extract_name_raw(&self, node: Node) -> String {
        if self.variant == Variant::Cpp {
            if let Some(hook) = self.extract_cpp_qualified_method_name(node) {
                return hook;
            }
        }
        if let Some(name_node) = node.child_by_field_name("declarator") {
            let mut resolved = name_node;
            // Unwrap pointer/reference declarators (`int* f()`, `T& f()`).
            while matches!(
                resolved.kind(),
                "pointer_declarator" | "reference_declarator"
            ) {
                let inner = resolved
                    .child_by_field_name("declarator")
                    .or_else(|| resolved.named_child(0));
                match inner {
                    Some(i) => resolved = i,
                    None => break,
                }
            }
            // C++ conversion operator: `operator <type>`.
            if resolved.kind() == "operator_cast" {
                return match resolved.named_child(0) {
                    Some(t) => format!("operator {}", self.text(t).trim()),
                    None => self.text(resolved).to_string(),
                };
            }
            if resolved.kind() == "function_declarator" || resolved.kind() == "declarator" {
                let inner = resolved
                    .child_by_field_name("declarator")
                    .or_else(|| resolved.named_child(0));
                return match inner {
                    Some(i) => self.text(i).to_string(),
                    None => self.text(resolved).to_string(),
                };
            }
            return self.text(resolved).to_string();
        }
        for child in named_children(node) {
            if matches!(
                child.kind(),
                "identifier" | "type_identifier" | "simple_identifier" | "constant"
            ) {
                return self.text(child).to_string();
            }
        }
        "<anonymous>".to_string()
    }

    /// extractCppQualifiedMethodName (languages/c-cpp.ts:75).
    pub(super) fn extract_cpp_qualified_method_name(&self, node: Node) -> Option<String> {
        if let Some(n) = self.recover_cpp_macro_defined_name(node) {
            return Some(n);
        }
        let declarator = node.child_by_field_name("declarator")?;
        let qid = find_declarator_qualified_id(declarator)?;
        let text = self.text(qid).trim();
        let parts: Vec<&str> = text.split("::").filter(|p| !p.is_empty()).collect();
        parts.last().map(|s| s.to_string())
    }

    /// recoverCppMacroDefinedName (languages/c-cpp.ts:49).
    pub(super) fn recover_cpp_macro_defined_name(&self, node: Node) -> Option<String> {
        if node.kind() != "function_definition" {
            return None;
        }
        let declarator = node.child_by_field_name("declarator")?;
        if declarator.kind() != "function_declarator" {
            return None;
        }
        let inner = declarator.child_by_field_name("declarator")?;
        if inner.kind() != "identifier" {
            return None;
        }
        let macro_name = self.text(inner);
        if !macro_shaped_re().is_match(macro_name) {
            return None;
        }
        let params = declarator.child_by_field_name("parameters")?;
        if params.named_child_count() < 2 {
            return None;
        }
        let lone_ident_text = |p: Node| -> Option<&'t str> {
            if p.kind() == "parameter_declaration"
                && p.named_child_count() == 1
                && p.named_child(0)
                    .map(|c| c.kind() == "type_identifier")
                    .unwrap_or(false)
            {
                Some(self.text(p.named_child(0).unwrap()))
            } else {
                None
            }
        };
        let name = params.named_child(0).and_then(lone_ident_text)?;
        if !has_lower_re().is_match(name) {
            return None;
        }
        for p in named_children(params).skip(1) {
            if lone_ident_text(p).is_some() {
                return None;
            }
        }
        Some(name.to_string())
    }

    /// extractCppReceiverType (languages/c-cpp.ts:86).
    pub(super) fn receiver_type_of(&self, node: Node) -> Option<String> {
        let declarator = node.child_by_field_name("declarator")?;
        let qid = find_declarator_qualified_id(declarator)?;
        let text = self.text(qid).trim();
        let parts: Vec<&str> = text.split("::").filter(|p| !p.is_empty()).collect();
        if parts.len() <= 1 {
            return None;
        }
        let receiver = strip_cpp_template_args(&parts[..parts.len() - 1].join("::"));
        if receiver.is_empty() {
            None
        } else {
            Some(receiver)
        }
    }

    /// extractCppReturnType: the `type` field, normalized.
    pub(super) fn return_type_of(&self, node: Node) -> Option<String> {
        let type_node = node.child_by_field_name("type")?;
        normalize_cpp_return_type(self.text(type_node))
    }

    /// cppExtractor.getVisibility: the FIRST access_specifier among the
    /// parent's children decides (document order, not nearest-preceding —
    /// bug-for-bug with the TS loop).
    pub(super) fn visibility_of(&self, node: Node) -> Option<u8> {
        let parent = node.parent()?;
        for i in 0..parent.child_count() {
            let Some(child) = parent.child(i) else {
                continue;
            };
            if child.kind() == "access_specifier" {
                let text = self.text(child);
                if text.contains("public") {
                    return Some(1);
                }
                if text.contains("private") {
                    return Some(2);
                }
                if text.contains("protected") {
                    return Some(3);
                }
            }
        }
        None
    }

    /// cExtractor.isConst: any named `type_qualifier` child reading "const".
    pub(super) fn is_const_declaration(&self, node: Node) -> bool {
        named_children(node).any(|c| c.kind() == "type_qualifier" && self.text(c) == "const")
    }

    /// cppExtractor.isMisparsedFunction (languages/c-cpp.ts:811). cpp only.
    pub(super) fn is_misparsed_function(&self, name: &str, node: Node) -> bool {
        if self.variant != Variant::Cpp {
            return false;
        }
        if name.starts_with("namespace") {
            return true;
        }
        if matches!(
            name,
            "switch" | "if" | "for" | "while" | "do" | "case" | "return"
        ) {
            return true;
        }
        is_macro_misparsed_type_decl(node)
    }

    /// composeReceiverQualifiedName (tree-sitter.ts:1424).
    pub(super) fn compose_receiver_qualified_name(
        &self,
        receiver_type: &str,
        name: &str,
    ) -> String {
        let base = format!("{receiver_type}::{name}");
        if self.namespace_prefix.is_empty() {
            return base;
        }
        let receiver_head = receiver_type.split("::").next().unwrap_or("");
        let anchor = self
            .namespace_prefix
            .iter()
            .position(|p| p == receiver_head);
        let prefix: &[String] = match anchor {
            Some(i) => &self.namespace_prefix[..i],
            None => &self.namespace_prefix[..],
        };
        if prefix.is_empty() {
            base
        } else {
            format!("{}::{}", prefix.join("::"), base)
        }
    }

    // --- visitNode -----------------------------------------------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        // C++ namespace blocks: prefix-only, no node (#1291/#1093). Anonymous
        // namespaces fall through to the generic walk.
        if self.variant == Variant::Cpp && kind == "namespace_definition" {
            let ns_name = node
                .child_by_field_name("name")
                .map(|n| self.text(n).to_string())
                .unwrap_or_default();
            if !ns_name.is_empty() {
                self.namespace_prefix.push(ns_name);
                self.visit_children(node);
                self.namespace_prefix.pop();
                return;
            }
        }

        self.maybe_capture_fn_refs(node);

        if kind == "function_definition" {
            // functionTypes for both; cpp's methodTypes also lists it, so
            // inside a class-like scope it extracts as a method.
            if self.inside_class_like() && self.variant == Variant::Cpp {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if self.variant == Variant::Cpp && kind == "class_specifier" {
            self.extract_class(node);
            skip_children = true;
        } else if kind == "struct_specifier" {
            self.extract_struct(node);
            skip_children = true;
        } else if kind == "enum_specifier" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "type_definition"
            || (self.variant == Variant::Cpp && kind == "alias_declaration")
        {
            skip_children = self.extract_type_alias(node);
        } else if kind == "declaration" && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "preproc_include" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            // INSTANTIATION_KINDS: cpp `new Foo(...)`. (No anonymous-class
            // body exists under new_expression in this grammar; children are
            // still walked for nested calls.)
            self.extract_instantiation(node);
        }

        if !skip_children {
            for child in named_children(node) {
                self.visit_node(child);
            }
        }
    }

    pub(super) fn find_child_by_kind(&self, node: Node<'t>, kind: &str) -> Option<Node<'t>> {
        named_children(node).find(|c| c.kind() == kind)
    }

    /// isCppStackConstruction (#1035).
    pub(super) fn is_cpp_stack_construction(&self, node: Node) -> bool {
        let Some(type_node) = node.child_by_field_name("type") else {
            return false;
        };
        if !matches!(
            type_node.kind(),
            "type_identifier" | "template_type" | "qualified_identifier"
        ) {
            return false;
        }
        for child in named_children(node) {
            if child.kind() != "init_declarator" {
                continue;
            }
            if let Some(value) = child.child_by_field_name("value") {
                if matches!(value.kind(), "argument_list" | "initializer_list") {
                    return true;
                }
            }
        }
        false
    }

    // --- function bodies -----------------------------------------------------

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            self.extract_instantiation(node);
        }

        // C++ stack construction `Calculator calc(0)` / `Widget w{1,2}` (#1035).
        if kind == "declaration"
            && self.variant == Variant::Cpp
            && self.is_cpp_stack_construction(node)
        {
            self.extract_instantiation(node);
        }

        // C++ local fn-pointer bindings: declarations and branch reassignments.
        if self.variant == Variant::Cpp && !self.stack.is_empty() {
            if kind == "declaration" {
                for child in named_children(node) {
                    if child.kind() != "init_declarator" {
                        continue;
                    }
                    let Some(decl) = child.child_by_field_name("declarator") else {
                        continue;
                    };
                    if decl.kind() != "identifier" {
                        continue;
                    }
                    let local = self.text(decl).to_string();
                    self.record_cpp_fn_ptr_binding(&local, child.child_by_field_name("value"));
                }
            } else if kind == "assignment_expression" {
                if let Some(left) = node.child_by_field_name("left") {
                    if left.kind() == "identifier" {
                        let local = self.text(left).to_string();
                        self.record_cpp_fn_ptr_binding(&local, node.child_by_field_name("right"));
                    }
                }
            }
        }

        // Static-member / value-read: `Foo.BAR`, `Foo->x` (cpp).
        self.extract_static_member_ref(node);

        // Nested NAMED functions become their own nodes.
        if kind == "function_definition" {
            let nested_name = self.extract_name(node);
            if !nested_name.is_empty() && nested_name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }

        // Structural nodes inside bodies (local classes; macro-misparse rescue).
        if self.variant == Variant::Cpp && kind == "class_specifier" {
            self.extract_class(node);
            return;
        }
        if kind == "struct_specifier" {
            self.extract_struct(node);
            return;
        }
        if kind == "enum_specifier" {
            self.extract_enum(node);
            return;
        }

        self.visit_call_children(node);
    }
}
