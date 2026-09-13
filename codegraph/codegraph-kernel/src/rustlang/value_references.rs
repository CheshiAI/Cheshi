//! value references for the rustlang extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- fn refs (RUST_SPEC) ----------------------------------------------------

    /// maybeCaptureFnRefs with RUST_SPEC's dispatch: arguments→args,
    /// assignment_expression→rhs(right), field_initializer→value(value),
    /// array_expression→list, static_item/let_declaration→varinit(value).
    /// No layers/unwrap/special — only bare identifiers qualify (`&handler`
    /// captures nothing). QUIRK: const_item is NOT in the dispatch.
    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            Rhs,
            Value,
            List,
            Varinit,
        }
        let mode = match node.kind() {
            "arguments" => Mode::Args,
            "assignment_expression" => Mode::Rhs,
            "field_initializer" => Mode::Value,
            "array_expression" => Mode::List,
            "static_item" | "let_declaration" => Mode::Varinit,
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            Mode::Args | Mode::List => {
                values.extend(util::named_children(node));
            }
            Mode::Rhs => {
                if let Some(rhs) = node.child_by_field_name("right") {
                    // Param-storage skip: `o.cb = cb`.
                    if !util::is_param_storage_assignment_node(node, self.src, rhs) {
                        values.push(rhs);
                    }
                }
            }
            Mode::Value => {
                let v = util::field_or_last_named(node, "value");
                if let Some(v) = v {
                    values.push(v);
                }
            }
            Mode::Varinit => {
                // Destructuring skip: a tuple/struct pattern LHS extracts data,
                // never a function alias (static_item's name is an identifier,
                // let_declaration's `pattern` field can be a pattern).
                let name_node = node
                    .child_by_field_name("name")
                    .or_else(|| node.child_by_field_name("pattern"));
                if let Some(nn) = name_node {
                    if matches!(
                        nn.kind(),
                        "object_pattern" | "array_pattern" | "tuple_pattern" | "struct_pattern"
                    ) {
                        return;
                    }
                }
                if let Some(v) = node.child_by_field_name("value") {
                    values.push(v);
                }
            }
        }

        for v in values {
            // normalizeValue: idTypes = {identifier} only, no layers/unwrap.
            if v.kind() == "identifier" {
                let name = self.text(v);
                util::record_fn_ref_candidate(&mut self.fn_ref_cands, from, name, v);
            }
        }
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        let stop = |node: Node, depth: u32| {
            depth > 0
                && matches!(
                    node.kind(),
                    "function_item"
                        | "function_signature_item"
                        | "arrow_function"
                        | "function_expression"
                        | "lambda_literal"
                        | "lambda_expression"
                )
        };
        let mut visit = |node: Node<'t>, _depth: u32| self.maybe_capture_fn_refs(node);
        util::walk_named_subtree(node, depth, 12, &stop, &mut visit);
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value refs -------------------------------------------------------------

    pub(super) fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if !crate::value_refs_enabled() {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune — rust declarator shapes: const_item/static_item (name
        // field) and let_declaration (the shadow source: `pattern` field; a
        // tuple pattern bumps every named child).
        let decl_counts =
            util::count_shadow_declarations_many(root, MAX_VALUE_REF_NODES, &targets, |node| {
                match node.kind() {
                    "const_item" | "static_item" => node
                        .child_by_field_name("name")
                        .filter(|name| matches!(name.kind(), "identifier" | "simple_identifier"))
                        .map(|name| vec![self.text(name).to_string()])
                        .unwrap_or_default(),
                    "let_declaration" => {
                        let Some(left) = util::child_by_fields(node, &["left", "pattern"], 0)
                        else {
                            return Vec::new();
                        };
                        if matches!(left.kind(), "identifier" | "simple_identifier") {
                            vec![self.text(left).to_string()]
                        } else {
                            util::named_identifier_texts(left, self.src)
                        }
                    }
                    _ => Vec::new(),
                }
            });
        let shadowed = util::shadowed_names(&decl_counts, &counts);
        for nm in shadowed {
            targets.remove(&nm);
        }
        if targets.is_empty() {
            return;
        }

        let state = &mut self.state;
        util::emit_value_ref_edges(
            util::ValueRefEmitContext {
                src: state.src,
                node_ids: &state.node_ids,
                arena: &mut state.arena,
                tables: &mut state.tables,
            },
            &scopes,
            &targets,
            MAX_VALUE_REF_NODES,
            &[],
        );
    }
}
