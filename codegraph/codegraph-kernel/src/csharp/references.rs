//! references for the csharp extractor.

use super::*;

impl<'t> Walker<'t> {
    /// extractImport via csharpExtractor.extractImport: moduleName = first
    /// qualified_name child's text, else first identifier's — with the alias
    /// quirks (alias-to-qualified keeps generic args on the TARGET text;
    /// alias-to-identifier captures the ALIAS name) preserved verbatim.
    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let import_text = util::source_text(self.src, node).trim().to_string();
        let target = util::named_children(node)
            .find(|c| c.kind() == "qualified_name")
            .or_else(|| util::first_named_child_kind(node, "identifier"));
        let Some(target) = target else { return }; // hook declined → no node, no ref
        let module_name = util::source_text(self.src, target).to_string();
        if module_name.is_empty() {
            return;
        }
        self.create_node(
            "import",
            &module_name,
            node,
            Extra {
                signature: Some(import_text),
                ..Extra::default()
            },
        );
        // One generic `imports` ref from the stack top (the namespace node in
        // a namespaced file, else the file node). No per-binding emitter.
        let parent = util::top_scope_row(&self.stack);
        self.push_ref_at(
            parent,
            &module_name.clone(),
            edge_kind_index("imports").unwrap(),
            node,
        );
    }

    /// extractCall — the C# branch (tree-sitter.ts:4502) + shared tail.
    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = util::top_scope_row(&self.stack);
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };

        let mut callee_name: String;
        if func.kind() == "member_access_expression" {
            let recv = func.child_by_field_name("expression");
            let name_node = func.child_by_field_name("name");
            let method_name = name_node
                .map(|n| util::source_text(self.src, n))
                .unwrap_or("");
            let chained = recv
                .map(|r| r.kind() == "invocation_expression" && !method_name.is_empty())
                .unwrap_or(false);
            if chained {
                // Chained factory `Foo.Create(args).Bar()` → `Foo.Create().Bar`
                // (inner whitespace stripped, EVERY call-receiver re-encodes —
                // no capitalization gate, unlike kotlin/scala).
                let inner_func = recv.unwrap().child_by_field_name("function");
                let inner_callee = inner_func
                    .map(|f| util::strip_js_whitespace(util::source_text(self.src, f)))
                    .unwrap_or_default();
                callee_name = if inner_callee.is_empty() {
                    method_name.to_string()
                } else {
                    format!("{inner_callee}().{method_name}")
                };
            } else {
                // RAW full member-access text: `this.Run`, `base.Method`,
                // `"lit".ToUpper`, multi-line fluent chains with their
                // newlines — no SKIP_RECEIVERS, no literal filter (preserve).
                callee_name = util::source_text(self.src, func).to_string();
            }
        } else {
            // Bare `Helper()`, generic `Generic<int>` kept verbatim,
            // `nameof(...)` → a calls ref named `nameof`, `?.` chains raw,
            // `(myDel)(x)` → parenthesized text (normalized below).
            callee_name = util::source_text(self.src, func).to_string();
        }

        // Shared parenthesized-conversion normalization — the one shared
        // normalization C# actually hits: `(myDel)(x)` → `myDel`.
        if !callee_name.is_empty() {
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
        }
        // (template strip + fn-ptr fan-out are c/cpp-gated — not C#.)

        if !callee_name.is_empty() {
            self.push_ref_at(
                caller,
                &callee_name.clone(),
                edge_kind_index("calls").unwrap(),
                node,
            );
        }
    }

    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let ctor = util::child_by_fields(node, &["constructor", "type", "name"], 0);
        let Some(ctor) = ctor else { return };
        // `new List<Foo>()` → `List`; `new Ns.Foo()` → `Foo`. Target-typed
        // `new()` / anonymous `new { }` / arrays `new T[n]` never reach here
        // (not in INSTANTIATION_KINDS) — invisible by design.
        let class_name = util::strip_generic_and_qualifier(util::source_text(self.src, ctor));
        if !class_name.is_empty() {
            let from = util::top_scope_row(&self.stack);
            self.push_ref_at(
                from,
                &class_name,
                edge_kind_index("instantiates").unwrap(),
                node,
            );
        }
    }

    /// extractStaticMemberRef — csharp ∈ STATIC_MEMBER_LANGS; C#'s
    /// member-access node with the `expression` receiver field.
    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "member_access_expression" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = util::top_scope_row(&self.stack);
        // Skip `Type.Method()` — the access is a call's callee, already linked.
        if let Some(parent) = node.parent() {
            if parent.kind() == "invocation_expression" {
                let callee = util::child_by_fields(parent, &["function", "method"], 0);
                if let Some(callee) = callee {
                    if callee.start_byte() == node.start_byte() {
                        return;
                    }
                }
            }
        }
        let recv = util::child_by_fields(node, &["object", "expression", "scope"], 0);
        let Some(recv) = recv else { return };
        if matches!(
            recv.kind(),
            "identifier"
                | "type_identifier"
                | "simple_identifier"
                | "name"
                | "scoped_type_identifier"
        ) {
            let text = util::source_text(self.src, recv);
            if util::is_capitalized_identifier(text) {
                self.push_ref_at(owner, text, edge_kind_index("references").unwrap(), recv);
            }
        }
    }

    /// extractInheritance — the C# base_list branch (5577): EVERY namedChild
    /// emits one `extends` ref (interfaces conflated by design; the garbage
    /// `(repo)` argument-list / `BaseDto(Name)` / `: byte` shapes preserved).
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for child in util::named_children(node) {
            if child.kind() != "base_list" {
                continue;
            }
            for base in util::named_children(child) {
                let name = if base.kind() == "generic_name" {
                    // `ClientBase<T>` → head identifier; position = generic_name.
                    let ident = util::first_named_child_kind(base, "identifier");
                    match ident {
                        Some(idn) => util::source_text(self.src, idn).to_string(),
                        None => util::source_text(self.src, base).to_string(),
                    }
                } else {
                    util::source_text(self.src, base).to_string()
                };
                self.push_ref_at(class_row, &name, extends_kind, base);
            }
        }
    }

    // --- C# type-reference engine (extractCsharpTypeRefs, 5893) -----------------

    pub(super) fn extract_csharp_type_refs(&mut self, node: Node<'t>, from_row: u32) {
        // Property `type` / method `returns` (a node carries only one).
        let direct = node
            .child_by_field_name("type")
            .or_else(|| node.child_by_field_name("returns"));
        if let Some(t) = direct {
            self.walk_type_position(t, from_row);
        }
        // Field declarations: the variable_declaration wrapper's `type` field.
        let var_decl = util::first_named_child_kind(node, "variable_declaration");
        if let Some(vd) = var_decl {
            if let Some(t) = vd.child_by_field_name("type") {
                self.walk_type_position(t, from_row);
            }
        }
        // Method/constructor parameters: ONLY each `parameter`'s `type` field.
        if let Some(params) = node.child_by_field_name("parameters") {
            self.walk_parameter_types(params, from_row);
        }
    }

    pub(super) fn emit_type_refs_if_present(&mut self, node: Node<'t>, row: Option<u32>) {
        if let Some(row) = row {
            self.extract_csharp_type_refs(node, row);
        }
    }

    pub(super) fn walk_parameter_types(&mut self, params: Node<'t>, from_row: u32) {
        for parameter in util::named_children(params).filter(|node| node.kind() == "parameter") {
            if let Some(parameter_type) = parameter.child_by_field_name("type") {
                self.walk_type_position(parameter_type, from_row);
            }
        }
    }

    /// extractCsharpPrimaryCtorParamRefs (5938) — the class/struct/record
    /// primary constructor's parameter_list (an unnamed-field child).
    pub(super) fn extract_primary_ctor_param_refs(&mut self, node: Node<'t>, owner_row: u32) {
        let param_list = util::first_named_child_kind(node, "parameter_list");
        let Some(param_list) = param_list else { return };
        self.walk_parameter_types(param_list, owner_row);
    }

    /// walkCsharpTypePosition (5955).
    pub(super) fn walk_type_position(&mut self, node: Node<'t>, from_row: u32) {
        match node.kind() {
            "predefined_type" => {}
            "identifier" => {
                let name = util::source_text(self.src, node);
                if !name.is_empty() && !util::is_builtin_type_name(name) {
                    self.push_ref_at(from_row, name, edge_kind_index("references").unwrap(), node);
                }
            }
            "qualified_name" => {
                // Rightmost segment is the type; position = the whole node.
                let text = util::source_text(self.src, node);
                let last = text.rsplit('.').next().unwrap_or(text);
                if !last.is_empty() && !util::is_builtin_type_name(last) {
                    self.push_ref_at(from_row, last, edge_kind_index("references").unwrap(), node);
                }
            }
            "tuple_element" => {
                // Walk the type field only — never the element NAME.
                if let Some(t) = node.child_by_field_name("type") {
                    self.walk_type_position(t, from_row);
                }
            }
            _ => {
                for child in util::named_children(node) {
                    self.walk_type_position(child, from_row);
                }
            }
        }
    }
}
