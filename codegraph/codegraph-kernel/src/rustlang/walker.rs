//! walker for the rustlang extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
        if kind_code == edge_kind_index("imports").unwrap() {
            // `::`-separated rust paths match NEITHER regex (separators are
            // `.`/`\`), so multi-segment use-imports contribute nothing to
            // the fn-ref gate — the rust gate is effectively same-file-only.
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
        let row = util::emit_node_row(&mut self.state, kind, name, node, extra)?;
        self.nodes_meta.push(NodeMeta {
            kind,
            name: name.to_string(),
        });

        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        // captureValueRefScope: rust consts are kind `variable` — still targets.
        let parent_kind = self.stack.last().map(|scope| scope.kind);
        util::record_value_ref_target_if(&mut self.state, kind, name, parent_kind, row);
        if util::is_value_ref_scope_node(kind) {
            self.value_scopes.push(ValueScope {
                row,
                node,
                name: name.to_string(),
            });
        }
        Some(row)
    }

    /// extractName — nameField `name`, else the identifier-like child scan.
    pub(super) fn extract_name(&self, node: Node) -> String {
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if let Some(identifier) = util::first_named_child_kind_any(
            node,
            &[
                "identifier",
                "type_identifier",
                "simple_identifier",
                "constant",
            ],
        ) {
            return self.text(identifier).to_string();
        }
        "<anonymous>".to_string()
    }

    /// rustExtractor.getSignature: raw params text + ` -> ` + raw return type.
    pub(super) fn signature_of(&self, node: Node) -> Option<String> {
        util::signature_from_fields(node, self.src, "parameters", "return_type", " -> ")
    }

    /// rustExtractor.getVisibility: direct `visibility_modifier` child whose
    /// text contains `pub` → public, else private; none → private.
    pub(super) fn visibility_of(&self, node: Node) -> u8 {
        if let Some(modifier) = util::first_named_child_kind(node, "visibility_modifier") {
            return if self.text(modifier).contains("pub") {
                1
            } else {
                2
            };
        }
        2 // private — Rust defaults to private
    }

    /// extractRustReturnType (languages/rust.ts:14).
    pub(super) fn return_type_of(&self, node: Node) -> Option<String> {
        let mut rt = node.child_by_field_name("return_type")?;
        if rt.kind() == "reference_type" {
            rt = util::named_children(rt)
                .find(|c| {
                    matches!(
                        c.kind(),
                        "type_identifier" | "scoped_type_identifier" | "generic_type"
                    )
                })
                .unwrap_or(rt);
        }
        if matches!(rt.kind(), "primitive_type" | "unit_type" | "tuple_type") {
            return None;
        }
        let text = self.text(rt).trim();
        let stripped = generic_angle_re().replace_all(text, "");
        let last = stripped.rsplit("::").next().unwrap_or("").trim();
        if last.is_empty() || !simple_ident_re().is_match(last) {
            return None;
        }
        Some(if last == "Self" {
            "self".to_string()
        } else {
            last.to_string()
        })
    }

    /// rustExtractor.getReceiverType: parent-walk to the nearest impl_item;
    /// LAST direct type_identifier child wins (for `impl Trait for Generic<T>`
    /// that's the TRAIT — bug preserved); else the first generic_type's inner
    /// type_identifier.
    pub(super) fn receiver_type_of(&self, node: Node) -> Option<String> {
        let mut parent = node.parent();
        while let Some(p) = parent {
            if p.kind() == "impl_item" {
                let type_idents: Vec<Node> = util::named_children(p)
                    .filter(|c| c.kind() == "type_identifier")
                    .collect();
                if let Some(last) = type_idents.last() {
                    return Some(self.text(*last).to_string());
                }
                let generic = util::named_children(p).find(|c| c.kind() == "generic_type");
                if let Some(g) = generic {
                    let inner = util::named_children(g).find(|c| c.kind() == "type_identifier");
                    if let Some(inner) = inner {
                        return Some(self.text(inner).to_string());
                    }
                }
                return None;
            }
            parent = p.parent();
        }
        None
    }

    // --- visitNode ------------------------------------------------------------

    pub(super) fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if matches!(kind, "function_item" | "function_signature_item") {
            self.extract_fn_or_method(node);
            skip_children = true;
        } else if kind == "trait_item" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "struct_item" {
            self.extract_struct(node);
            skip_children = true;
        } else if kind == "enum_item" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "type_item" {
            self.extract_type_alias(node);
            // extractTypeAlias returns false for rust (plain alias) — children
            // are visited (nothing in them has a branch).
        } else if matches!(kind, "let_declaration" | "const_item" | "static_item")
            && !self.inside_class_like()
        {
            // Inside a class-like scope the gate fails and the else-ladder
            // falls through with children VISITED — a trait const's value
            // expression emits calls refs from the trait node.
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "use_declaration" {
            self.extract_import(node);
            // importTypes branch never sets skipChildren.
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "struct_expression" {
            self.extract_instantiation(node);
        } else if kind == "impl_item" {
            // Emits the implements back-reference; skipChildren stays false so
            // the declaration_list is visited at FILE scope (impl pushes
            // nothing on the stack).
            self.extract_rust_impl_item(node);
        }

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    // --- extractors --------------------------------------------------------------

    /// extractFunction/extractMethod, decision resolved once: method iff a
    /// receiver is found (fn inside an impl — including a NESTED fn inside an
    /// impl method's body, whose parent walk passes through the outer fn) or
    /// the stack top is class-like (trait members).
    pub(super) fn extract_fn_or_method(&mut self, node: Node<'t>) {
        let receiver = self.receiver_type_of(node);
        let as_method = receiver.is_some() || self.inside_class_like();

        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }

        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: self.signature_of(node),
            visibility: Some(self.visibility_of(node)),
            // isAsync hook exists but never finds a direct `async` child (it
            // nests in function_modifiers) — present-false on every node.
            is_async: Some(false),
            return_type: self.return_type_of(node),
            qualified_name: receiver.as_ref().map(|r| format!("{r}::{name}")),
            ..Extra::default() // isExported hook absent → flag not set
        };
        let kind: &'static str = if as_method { "method" } else { "function" };
        let Some(row) = self.create_node(kind, &name, node, extra) else {
            return;
        };

        // Contains edge from the owner: receiver present AND not class-like —
        // FIRST earlier-in-file struct/class/enum/trait of the receiver's name.
        if as_method && !self.inside_class_like() {
            if let Some(receiver) = &receiver {
                let owner_row = prior_owner_row(&self.nodes_meta, receiver);
                if let Some(owner_row) = owner_row {
                    util::emit_contains_edge(&mut self.tables, owner_row, row);
                }
            }
        }

        self.extract_type_annotations(node, row);
        // extractDecoratorsFor: rust attribute_items are siblings, not
        // decorator/annotation/attribute node types — complete no-op.
        let body = node.child_by_field_name("body");
        self.with_scope(row, kind, name, |walker| {
            if let Some(body) = body {
                walker.visit_function_body(body);
            }
        });
    }

    /// getRootModule (languages/rust.ts:124).
    pub(super) fn root_module(&self, n: Node) -> String {
        let Some(first) = n.named_child(0) else {
            return self.text(n).to_string();
        };
        match first.kind() {
            "identifier" | "crate" | "super" | "self" => self.text(first).to_string(),
            "scoped_identifier" => self.root_module(first),
            _ => self.text(first).to_string(),
        }
    }

    /// emitRustUseBindingRefs (tree-sitter.ts:3451) — one FULL-path `imports`
    /// ref per binding; `Path as Alias` links the source path; leaves that are
    /// only `self`/`super`/`crate`/`*` are skipped.
    pub(super) fn emit_use_binding_refs(&mut self, node: Node<'t>, from_row: u32) {
        let mut paths: Vec<(String, Node)> = Vec::new();
        fn join(prefix: &str, seg: &str) -> String {
            if prefix.is_empty() {
                seg.to_string()
            } else {
                format!("{prefix}::{seg}")
            }
        }
        fn collect<'t>(
            w: &Walker<'t>,
            n: Node<'t>,
            prefix: &str,
            paths: &mut Vec<(String, Node<'t>)>,
        ) {
            match n.kind() {
                "identifier" => paths.push((join(prefix, w.text(n)), n)),
                "scoped_identifier" => {
                    let full = w.text(n).trim();
                    paths.push((
                        if prefix.is_empty() {
                            full.to_string()
                        } else {
                            format!("{prefix}::{full}")
                        },
                        n,
                    ));
                }
                "scoped_use_list" => {
                    let seg = n
                        .child_by_field_name("path")
                        .map(|p| w.text(p).trim().to_string())
                        .unwrap_or_default();
                    let new_prefix = if seg.is_empty() {
                        prefix.to_string()
                    } else {
                        join(prefix, &seg)
                    };
                    let list = n
                        .child_by_field_name("list")
                        .or_else(|| util::first_named_child_kind(n, "use_list"));
                    if let Some(list) = list {
                        collect(w, list, &new_prefix, paths);
                    }
                }
                "use_list" => {
                    for child in util::named_children(n) {
                        collect(w, child, prefix, paths);
                    }
                }
                "use_as_clause" => {
                    let p = n.child_by_field_name("path").or_else(|| n.named_child(0));
                    if let Some(p) = p {
                        collect(w, p, prefix, paths);
                    }
                }
                _ => {} // visibility_modifier, use_wildcard, bare crate/self/super
            }
        }
        for child in util::named_children(node) {
            collect(self, child, "", &mut paths);
        }
        let imports_kind = edge_kind_index("imports").unwrap();
        for (text, n) in paths {
            let leaf = text.rsplit("::").next().unwrap_or("");
            if leaf.is_empty() || matches!(leaf, "self" | "super" | "crate" | "*") {
                continue;
            }
            self.push_ref_at(from_row, &text, imports_kind, n);
        }
    }

    /// extractRustRouteMacro — body-walker-only; bare `routes`/`catchers`
    /// identifiers only (`rocket::routes![…]` is skipped); identifier runs in
    /// the token tree join with `::`, flushed on `,` and at end.
    pub(super) fn extract_rust_route_macro(&mut self, node: Node<'t>) {
        let Some(macro_name) = node.named_child(0) else {
            return;
        };
        let name = self.text(macro_name);
        if name != "routes" && name != "catchers" {
            return;
        }
        let token_tree = util::first_named_child_kind(node, "token_tree");
        let Some(token_tree) = token_tree else { return };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        let refs_kind = edge_kind_index("references").unwrap();

        let mut parts: Vec<&str> = Vec::new();
        let mut line = 0u32;
        let mut column_byte = 0usize;
        let mut row = 0usize;
        macro_rules! flush {
            () => {
                if !parts.is_empty() {
                    let joined = parts.join("::");
                    let column = util::col16(self.src, &self.line_starts, row, column_byte);
                    let name_ref = self.arena.put(&joined);
                    self.tables.push_ref(&RefRow {
                        from_idx: from,
                        kind: refs_kind,
                        line,
                        column,
                        reference_name: name_ref,
                        candidates: NONE_STR,
                        from_id_str: NONE_STR,
                    });
                    parts.clear();
                }
            };
        }
        for i in 0..token_tree.child_count() {
            let Some(t) = token_tree.child(i) else {
                continue;
            };
            if t.kind() == "identifier" {
                if parts.is_empty() {
                    line = t.start_position().row as u32 + 1;
                    column_byte = t.start_byte();
                    row = t.start_position().row;
                }
                parts.push(self.text(t));
            } else if t.kind() == "," {
                flush!();
            }
        }
        flush!();
    }

    /// extractRustImplItem — `impl Trait for Type` back-reference: positional
    /// type-node filter (NEVER the grammar's trait:/type: fields), ≥2 needed,
    /// target found by FIRST earlier node of kind struct/enum/class (never
    /// trait); ref FROM the type's node, named by the trait's full text.
    pub(super) fn extract_rust_impl_item(&mut self, node: Node<'t>) {
        let has_for = (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "for" && !c.is_named());
        if !has_for {
            return;
        }
        let type_idents: Vec<Node> = util::named_children(node)
            .filter(|c| {
                matches!(
                    c.kind(),
                    "type_identifier" | "generic_type" | "scoped_type_identifier"
                )
            })
            .collect();
        if type_idents.len() < 2 {
            return;
        }
        let trait_node = type_idents[0];
        let type_node = type_idents[type_idents.len() - 1];

        let trait_name = self.text(trait_node).to_string();
        let type_name = if type_node.kind() == "generic_type" {
            util::first_named_child_kind(type_node, "type_identifier")
                .map(|c| self.text(c).to_string())
                .unwrap_or_else(|| self.text(type_node).to_string())
        } else {
            self.text(type_node).to_string()
        };

        let target_row = self
            .nodes_meta
            .iter()
            .position(|m| m.name == type_name && matches!(m.kind, "struct" | "enum" | "class"))
            .map(|i| i as u32);
        if let Some(target_row) = target_row {
            self.push_ref_at(
                target_row,
                &trait_name,
                edge_kind_index("implements").unwrap(),
                trait_node,
            );
        }
    }

    // --- visitFunctionBody -----------------------------------------------------

    pub(super) fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    pub(super) fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        // Rocket route macros: handler paths live in a raw token tree.
        if kind == "macro_invocation" {
            self.extract_rust_route_macro(node);
        }

        if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "struct_expression" {
            self.extract_instantiation(node);
        }

        // Nested NAMED fns become their own nodes (a nested fn inside an impl
        // method walks up to the impl and indexes as a METHOD).
        if matches!(kind, "function_item" | "function_signature_item") {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_fn_or_method(node);
                return;
            }
        }

        // Structural nodes inside bodies.
        if kind == "struct_item" {
            self.extract_struct(node);
            return;
        }
        if kind == "enum_item" {
            self.extract_enum(node);
            return;
        }
        if kind == "trait_item" {
            self.extract_interface(node);
            return;
        }

        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }
}
