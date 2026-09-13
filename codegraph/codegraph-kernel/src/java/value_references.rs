//! value references for the java extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- function-as-value refs (JAVA_SPEC: method references only) ----------------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let mode_field: Option<&str> = match node.kind() {
            "argument_list" => Some(""), // args: every named child
            "assignment_expression" => Some("right"),
            "variable_declarator" => Some("value"),
            _ => None,
        };
        let Some(field) = mode_field else { return };
        if self.state.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        if field.is_empty() {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    values.push(c);
                }
            }
        } else if field == "right" {
            if let Some(rhs) = node.child_by_field_name("right") {
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
        } else if let Some(v) = node.child_by_field_name("value") {
            // varinit — destructuring patterns don't exist in Java.
            values.push(v);
        }

        for v in values {
            if v.kind() != "method_reference" {
                continue; // idTypes is EMPTY for Java — only method references
            }
            let mut last_ident: Option<Node> = None;
            for i in 0..v.named_child_count() {
                if let Some(c) = v.named_child(i) {
                    if c.kind() == "identifier" {
                        last_ident = Some(c);
                    }
                }
            }
            let Some(last) = last_ident else { continue };
            let m = self.text(last);
            let text = self.text(v);
            let name = if text.starts_with("this::") || text.starts_with("super::") {
                format!("this.{m}")
            } else if let Some(c) = method_ref_type_re().captures(text) {
                if m == "new" {
                    continue;
                }
                format!("{}::{m}", &c[1])
            } else {
                continue;
            };
            let p = last.start_position();
            self.state.fn_ref_cands.push(Cand {
                from,
                name,
                line: p.row as u32 + 1,
                column_byte: last.start_byte(),
                row: p.row,
            });
        }
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        util::walk_fn_ref_subtree(
            node,
            depth,
            12,
            &["lambda_literal", "lambda_expression"],
            &mut |candidate| self.maybe_capture_fn_refs(candidate),
        );
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value references ------------------------------------------------------------

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

        let decl_counts =
            util::count_shadow_declarations(root, MAX_VALUE_REF_NODES, &targets, |node| {
                (node.kind() == "variable_declarator")
                    .then(|| node.named_child(0))
                    .flatten()
                    .filter(|child| child.kind() == "identifier")
                    .map(|child| self.text(child).to_string())
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
