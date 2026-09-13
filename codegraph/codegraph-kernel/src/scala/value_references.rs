//! value references for the scala extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- function-as-value capture (#756) — SCALA_SPEC --------------------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "arguments" => ("args", ""),
            "assignment_expression" => ("rhs", "right"),
            "val_definition" => ("varinit", "value"),
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
        match mode {
            "args" => {
                values.extend(util::named_children(node));
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
                    // Param-storage skip: lhs tail == rhs text.
                    let lhs = util::child_by_fields_if_named_count(
                        node,
                        &["left", "lhs", "target"],
                        0,
                        2,
                    );
                    let lhs_text = lhs.map(|left| self.text(left)).unwrap_or("");
                    if !util::is_param_storage_assignment(lhs_text, self.text(rhs)) {
                        values.push(rhs);
                    }
                }
            }
            _ => {
                // varinit — destructuring patterns capture nothing.
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
                if let Some(v) = node.child_by_field_name(field) {
                    values.push(v);
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue with SCALA_SPEC's unwrap (postfix_expression → first
    /// named child — eta-expansion `handler _`). No layers.
    pub(super) fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = self.text(v).to_string();
                if name.is_empty() || is_stoplisted(&name) {
                    return;
                }
                let p = v.start_position();
                self.fn_ref_cands.push(Cand {
                    from,
                    name,
                    line: p.row as u32 + 1,
                    column_byte: v.start_byte(),
                    row: p.row,
                });
            }
            "postfix_expression" => {
                if let Some(inner) = v.named_child(0) {
                    self.normalize_fn_ref_value(inner, from, depth + 1);
                }
            }
            _ => {}
        }
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        let stop = |node: Node, depth: u32| {
            depth > 0
                && matches!(
                    node.kind(),
                    "arrow_function"
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

    // --- value-reference edges (:398-931) ---------------------------------

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

        // Shadow prune — the scala declarator shape: val_definition /
        // var_definition with an `identifier` pattern (tuple/case-class
        // patterns bump nothing).
        let decl_counts =
            util::count_shadow_declarations(root, MAX_VALUE_REF_NODES, &targets, |node| {
                if !matches!(node.kind(), "val_definition" | "var_definition") {
                    return None;
                }
                node.child_by_field_name("pattern")
                    .filter(|pattern| pattern.kind() == "identifier")
                    .map(|pattern| self.text(pattern).to_string())
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
            &["function_body", "block"],
        );
    }
}
