//! value references for the go extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- fn refs (GO_SPEC, with the literal_element/expression_list layers) --------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "argument_list" => ("args", ""),
            "assignment_statement" => ("rhs", "right"),
            "short_var_declaration" => ("rhs", "right"),
            "var_spec" => ("varinit", "value"),
            "keyed_element" => ("value", ""), // value = LAST named child
            "literal_value" => ("list", ""),
            _ => return,
        };
        if self.state.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            "args" | "list" => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        values.push(c);
                    }
                }
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
                    let lhs_text = node
                        .child_by_field_name("left")
                        .map(|l| self.text(l))
                        .unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    if !(lhs_last.is_some() && lhs_last == Some(self.text(rhs).trim())) {
                        values.push(rhs);
                    }
                }
            }
            "value" => {
                let v = node.child_by_field_name("value").or_else(|| {
                    if node.named_child_count() > 0 {
                        node.named_child(node.named_child_count() - 1)
                    } else {
                        None
                    }
                });
                if let Some(v) = v {
                    values.push(v);
                }
            }
            _ => {
                // varinit — Go var_spec names are plain identifiers (no
                // destructuring patterns to skip).
                if let Some(v) = node.child_by_field_name(field) {
                    values.push(v);
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue with GO_SPEC's transparent layers (literal_element,
    /// expression_list — both fan out to named children).
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
                self.state.fn_ref_cands.push(Cand {
                    from,
                    name,
                    line: p.row as u32 + 1,
                    column_byte: v.start_byte(),
                    row: p.row,
                });
            }
            "literal_element" | "expression_list" => {
                for i in 0..v.named_child_count() {
                    if let Some(c) = v.named_child(i) {
                        self.normalize_fn_ref_value(c, from, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        util::walk_fn_ref_subtree(node, depth, 12, GO_FN_REF_STOP_KINDS, &mut |candidate| {
            self.maybe_capture_fn_refs(candidate)
        });
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value refs -------------------------------------------------------------------

    pub(super) fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.state.value_scopes);
        let mut targets = std::mem::take(&mut self.state.fs_values);
        let counts = std::mem::take(&mut self.state.fs_value_counts);
        if !crate::value_refs_enabled() {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.state.file_path)
        {
            return;
        }

        // Shadow prune — Go declarator shapes: const_spec/var_spec (name =
        // first child) and short_var_declaration (left / expression_list).
        let decl_counts =
            util::count_shadow_declarations_many(root, MAX_VALUE_REF_NODES, &targets, |node| {
                match node.kind() {
                    "const_spec" | "var_spec" => node
                        .named_child(0)
                        .filter(|child| matches!(child.kind(), "identifier" | "simple_identifier"))
                        .map(|child| vec![self.text(child).to_string()])
                        .unwrap_or_default(),
                    "short_var_declaration" => {
                        let Some(left) = util::child_by_fields(node, &["left", "pattern"], 0)
                        else {
                            return Vec::new();
                        };
                        if matches!(left.kind(), "identifier" | "simple_identifier") {
                            vec![self.text(left).to_string()]
                        } else {
                            util::named_identifier_texts(left, self.state.src)
                        }
                    }
                    _ => Vec::new(),
                }
            });
        util::prune_shadowed_targets(&mut targets, &decl_counts, &counts);
        if targets.is_empty() {
            return;
        }

        util::emit_state_value_ref_edges(
            &mut self.state,
            &scopes,
            &targets,
            MAX_VALUE_REF_NODES,
            &[],
        );
    }
}
