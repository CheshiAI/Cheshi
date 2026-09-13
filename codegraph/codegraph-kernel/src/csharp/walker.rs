//! walker for the csharp extractor.

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
        let line = util::node_line(node);
        let column = util::node_column(self.src, &self.line_starts, node);
        self.push_ref(from_row, name, kind_code, line, column);
    }

    // --- createNode ------------------------------------------------------------

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
        let start_line = util::node_line(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);
        let end_line = node.end_position().row as u32 + 1; // no resolveBody for csharp

        let qualified = util::join_qualified_name(
            self.stack
                .iter()
                .filter(|scope| scope.kind != "file")
                .map(|scope| scope.name.as_str()),
            name,
        );

        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
        }
        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let ret_ref = opt_str(&mut self.arena, extra.return_type.as_deref());
        let start_column = util::node_column(self.src, &self.line_starts, node);
        let end_column = util::node_end_column(self.src, &self.line_starts, node);
        let row = self.tables.push_node(&NodeRow::new(NodeRowInput {
            kind: node_kind_index(kind).unwrap(),
            visibility: extra.visibility.unwrap_or(0),
            flags,
            start_line,
            end_line,
            start_column,
            end_column,
            name: name_ref,
            qualified_name: qn_ref,
            id: id_ref,
            docstring: doc_ref,
            signature: sig_ref,
            return_type: ret_ref,
        }));
        self.node_ids.push(id);

        let parent_row = util::top_scope_row(&self.stack);
        self.tables.push_edge(&EdgeRow::new(
            parent_row,
            row,
            edge_kind_index("contains").unwrap(),
            NONE_STR,
        ));

        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        self.capture_value_ref_scope(kind, name, row, node);
        Some(row)
    }

    // --- hooks (languages/csharp.ts) --------------------------------------------
    //
    // C# modifiers are individual named `modifier` children — there is NO
    // Java-style `modifiers` wrapper (probed).

    /// getVisibility: FIRST `modifier` child whose text is one of the four
    /// levels wins; none → private (the C# default).
    pub(super) fn visibility_of(&self, node: Node) -> u8 {
        (0..node.child_count())
            .filter_map(|index| node.child(index))
            .filter(|child| child.kind() == "modifier")
            .find_map(|child| match util::source_text(self.src, child) {
                "public" => Some(1),
                "private" => Some(2),
                "protected" => Some(3),
                "internal" => Some(4),
                _ => None,
            })
            .unwrap_or(2)
    }

    pub(super) fn is_static(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|index| node.child(index))
            .any(|child| {
                child.kind() == "modifier" && util::source_text(self.src, child) == "static"
            })
    }

    pub(super) fn is_async(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|index| node.child(index))
            .any(|child| {
                child.kind() == "modifier" && util::source_text(self.src, child) == "async"
            })
    }

    /// isConst: `const` → true; else `static` AND `readonly` both present.
    pub(super) fn is_const(&self, node: Node) -> bool {
        let mut has_static = false;
        let mut has_readonly = false;
        for child in (0..node.child_count()).filter_map(|index| node.child(index)) {
            if child.kind() != "modifier" {
                continue;
            }
            match util::source_text(self.src, child) {
                "const" => return true,
                "static" => has_static = true,
                "readonly" => has_readonly = true,
                _ => {}
            }
        }
        has_static && has_readonly
    }

    /// extractCsharpReturnType — reads the `returns` field; feeds the
    /// #645/#608 chained-call resolution. Constructors have no `returns`.
    pub(super) fn return_type_of(&self, node: Node) -> Option<String> {
        let t = node.child_by_field_name("returns")?;
        if matches!(t.kind(), "predefined_type" | "array_type") {
            return None;
        }
        let mut s = util::source_text(self.src, t).trim().to_string();
        s = util::strip_trailing_nullable(&s);
        s = util::strip_non_nested_generic_args(&s);
        let last = s.rsplit('.').next().unwrap_or("").trim().to_string();
        if last.is_empty() || !util::is_ascii_identifier(&last) {
            return None;
        }
        Some(last)
    }

    pub(super) fn function_extra(&self, node: Node) -> Extra {
        Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
            is_exported: None,
            ..Extra::default()
        }
    }

    pub(super) fn bare_field_extra(
        docstring: Option<String>,
        visibility: Option<u8>,
        is_static: Option<bool>,
    ) -> Extra {
        Extra {
            docstring,
            visibility,
            is_static,
            ..Extra::default()
        }
    }

    /// extractName (tree-sitter.ts:90) — the C#-reachable paths: the `name`
    /// field (always present on named declarations), else the shared
    /// identifier scan, else `<anonymous>`.
    pub(super) fn extract_name(&self, node: Node) -> String {
        if let Some(name_node) = node.child_by_field_name("name") {
            return util::source_text(self.src, name_node).to_string();
        }
        if let Some(child) = util::first_named_child_kind_any(
            node,
            &[
                "identifier",
                "type_identifier",
                "simple_identifier",
                "constant",
            ],
        ) {
            return util::source_text(self.src, child).to_string();
        }
        "<anonymous>".to_string()
    }

    // --- the dispatcher (visitNode, C#-relevant branches) -----------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "class_declaration" || kind == "record_declaration" {
            // classifyClassNode: `record struct` → extractStruct, else class.
            if kind == "record_declaration" && util::has_child_kind(node, "struct") {
                self.extract_struct(node);
            } else {
                self.extract_class(node);
            }
            skip_children = true;
        } else if kind == "method_declaration" || kind == "constructor_declaration" {
            self.extract_method(node);
            skip_children = true;
        } else if kind == "interface_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "struct_declaration" || kind == "record_struct_declaration" {
            self.extract_struct(node);
            skip_children = true;
        } else if kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "property_declaration" && util::inside_class_like(&self.stack) {
            // Property accessor/expression bodies are NEVER walked (calls
            // inside are lost by design) — candidates-only scan.
            self.extract_property(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "field_declaration" && util::inside_class_like(&self.stack) {
            self.extract_field(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "local_declaration_statement" && !util::inside_class_like(&self.stack) {
            // Top-level statements: extractVariable's generic fallback finds no
            // direct identifier/variable_declarator children (C# nests them in
            // variable_declaration) → ZERO nodes, zero refs. Candidates only.
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "using_directive" {
            self.extract_import(node);
            // no skipChildren (TS importTypes branch) — children visited below
        } else if kind == "invocation_expression" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = util::named_children(node)
                .find(|child| matches!(child.kind(), "class_body" | "declaration_list"))
            {
                self.extract_anonymous_class(node, anon_body);
                skip_children = true;
            }
        }
        // Everything else (namespace_declaration, global_statement, delegates,
        // events, operators, indexers, destructors, local functions, preproc_*)
        // falls through: no node minted, children visited — their bodies' calls
        // attribute to the enclosing scope (checklist §dispatch).

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    // --- visitFunctionBody ------------------------------------------------------

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "invocation_expression" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = util::named_children(node)
                .find(|child| matches!(child.kind(), "class_body" | "declaration_list"))
            {
                self.extract_anonymous_class(node, anon_body);
                return;
            }
        }

        // Static value reads (`ReadType.ReadAsDouble`) — body walker only.
        self.extract_static_member_ref(node);

        // (variable_declarator type-annotation branch: C# has no
        // `type_annotation` child node — structurally inert, not ported.
        // functionTypes is empty — no nested-function branch.)

        if kind == "class_declaration" || kind == "record_declaration" {
            if kind == "record_declaration" && util::has_child_kind(node, "struct") {
                self.extract_struct(node);
            } else {
                self.extract_class(node);
            }
            return;
        }
        if kind == "struct_declaration" || kind == "record_struct_declaration" {
            self.extract_struct(node);
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
}
