//! value references for the kotlin extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- function-as-value refs (KOTLIN_SPEC, function-ref.ts:240) ------------------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            Rhs,
        }
        let mode = match node.kind() {
            "value_arguments" => Mode::Args,
            "assignment" => Mode::Rhs, // NO field — RHS = LAST named child
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            Mode::Args => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        values.push(c);
                    }
                }
            }
            Mode::Rhs => {
                let rhs = if node.named_child_count() > 0 {
                    node.named_child(node.named_child_count() - 1)
                } else {
                    None
                };
                if let Some(rhs) = rhs {
                    let lhs = util::child_by_fields_if_named_count(
                        node,
                        &["left", "lhs", "target"],
                        0,
                        2,
                    );
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    let rhs_text = self.text(rhs).trim();
                    if !(lhs_last.is_some() && lhs_last == Some(rhs_text)) {
                        values.push(rhs);
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    pub(super) fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            // value_argument layer with NO field resolution (zero fields) —
            // the label-forward skip is DEAD for kotlin; fan out namedChildren.
            "value_argument" => {
                for i in 0..v.named_child_count() {
                    if let Some(c) = v.named_child(i) {
                        self.normalize_fn_ref_value(c, from, depth + 1);
                    }
                }
            }
            // `::topLevel` / `OtherClass::handle` — receiver = LAST
            // type_identifier child, member = LAST simple_identifier child;
            // `String::class` has no member (anon keyword) → nothing;
            // lowercase receivers dropped by the CASE regex, not node type.
            "callable_reference" => {
                let mut receiver: Option<Node> = None;
                let mut member: Option<Node> = None;
                for i in 0..v.named_child_count() {
                    let Some(child) = v.named_child(i) else {
                        continue;
                    };
                    if child.kind() == "type_identifier" {
                        receiver = Some(child);
                    }
                    if child.kind() == "simple_identifier" {
                        member = Some(child);
                    }
                }
                let Some(member) = member else { return };
                let m = self.text(member);
                match receiver {
                    None => self.push_fn_ref_cand(from, m, member),
                    Some(recv) => {
                        let recv_text = self.text(recv);
                        if recv_text
                            .as_bytes()
                            .first()
                            .map(|b| b.is_ascii_uppercase())
                            .unwrap_or(false)
                        {
                            let name = format!("{recv_text}::{m}");
                            self.push_fn_ref_cand(from, &name, member);
                        }
                    }
                }
            }
            // `this::caller` → this.<member> (class-scoped, always flushes).
            "navigation_expression" => {
                if !self.text(v).starts_with("this::") {
                    return;
                }
                for i in 0..v.named_child_count() {
                    let Some(child) = v.named_child(i) else {
                        continue;
                    };
                    if child.kind() == "navigation_suffix" && self.text(child).starts_with("::") {
                        if child.named_child_count() > 0 {
                            if let Some(id) = child.named_child(child.named_child_count() - 1) {
                                let name = format!("this.{}", self.text(id));
                                self.push_fn_ref_cand(from, &name, id);
                            }
                        }
                        return;
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node) {
        if name.is_empty() || is_stoplisted(name) {
            return;
        }
        util::record_fn_ref_candidate(&mut self.state.fn_ref_cands, from, name, node);
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        util::walk_fn_ref_subtree(
            node,
            depth,
            12,
            &[
                "function_declaration",
                "arrow_function",
                "function_expression",
                "lambda_literal",
                "lambda_expression",
            ],
            &mut |candidate| self.maybe_capture_fn_refs(candidate),
        );
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value references --------------------------------------------------------------

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

        // Shadow prune — kotlin cases: property_declaration (its
        // variable_declaration's first simple_identifier; destructuring bumps
        // nothing) AND the shared `assignment` case (the swift-sweep lesson —
        // directly_assignable_expression children bump).
        let decl_counts =
            util::count_shadow_declarations_many(root, MAX_VALUE_REF_NODES, &targets, |node| {
                let mut names = Vec::new();
                names.extend(util::assignment_declared_names_with_kinds(
                    node,
                    self.src,
                    &["identifier"],
                    &["identifier", "simple_identifier"],
                ));
                if node.kind() == "property_declaration" {
                    if let Some(variable) =
                        util::first_named_child_kind(node, "variable_declaration")
                    {
                        if let Some(identifier) =
                            util::first_named_child_kind(variable, "simple_identifier")
                        {
                            names.push(self.text(identifier).to_string());
                        }
                    }
                }
                names
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
