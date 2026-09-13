//! value references for the dart extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- function-as-value capture (#756) — DART_SPEC ---------------------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "arguments" => ("args", ""),
            "assignment_expression" => ("rhs", "right"),
            "pair" => ("value", "value"),
            "list_literal" => ("list", ""),
            "static_final_declaration" => ("varinit", ""),
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
        match mode {
            "args" | "list" => {
                let mut cursor = node.walk();
                for c in node.named_children(&mut cursor) {
                    values.push(c);
                }
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
                    let lhs = node
                        .child_by_field_name("left")
                        .or_else(|| node.child_by_field_name("lhs"))
                        .or_else(|| node.child_by_field_name("target"))
                        .or_else(|| {
                            if node.named_child_count() >= 2 {
                                node.named_child(0)
                            } else {
                                None
                            }
                        });
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
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
                let v = node.child_by_field_name(field).or_else(|| {
                    let count = node.named_child_count();
                    if count > 0 {
                        node.named_child(count - 1)
                    } else {
                        None
                    }
                });
                if let Some(v) = v {
                    values.push(v);
                }
            }
            _ => {
                // varinit, NO field (function-ref.ts:471-487): the last named
                // child, requiring ≥2 named children; the name-field guard is
                // inert (static_final_declaration has no name/pattern field).
                let count = node.named_child_count();
                if count >= 2 {
                    if let Some(v) = node.named_child(count - 1) {
                        values.push(v);
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue with DART_SPEC's one layer (`argument` → fan out).
    /// Named arguments are NOT captured (named_argument is not a layer).
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
            "argument" => {
                let mut cursor = v.walk();
                let kids: Vec<Node<'t>> = v.named_children(&mut cursor).collect();
                for c in kids {
                    self.normalize_fn_ref_value(c, from, depth + 1);
                }
            }
            _ => {}
        }
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // Halt list: functionTypes (function_signature) + the lambda kinds —
        // function_expression IS dart's lambda, so constant-initializer
        // lambdas don't leak candidates.
        if depth > 0
            && matches!(
                node.kind(),
                "function_signature"
                    | "arrow_function"
                    | "function_expression"
                    | "lambda_literal"
                    | "lambda_expression"
            )
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for c in children {
            self.scan_fn_ref_subtree(c, depth + 1);
        }
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        util::flush_fn_ref_candidates(util::FnRefFlushInput {
            candidates: std::mem::take(&mut self.fn_ref_cands),
            file_path: self.file_path,
            node_ids: &self.node_ids,
            src: self.src,
            line_starts: &self.line_starts,
            arena: &mut self.arena,
            tables: &mut self.tables,
            defined_names: &self.defined_fn_names,
            imported_names: &self.imported_names,
        });
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

        // Shadow prune — the dart declarator shapes (:844-850): each bumps
        // its first identifier-typed named child. Uninitialized locals bump;
        // assignment_expression is NOT a prune case.
        let mut decl_counts: HashMap<&str, u32> = HashMap::new();
        let mut dstack: Vec<Node> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            if matches!(
                n.kind(),
                "static_final_declaration"
                    | "initialized_identifier"
                    | "initialized_variable_definition"
            ) {
                let mut cursor = n.walk();
                let id = n
                    .named_children(&mut cursor)
                    .find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    let nm = self.text(id);
                    if targets.contains_key(nm) {
                        *decl_counts.entry(nm).or_insert(0) += 1;
                    }
                }
            }
            for i in 0..n.named_child_count() {
                if let Some(c) = n.named_child(i) {
                    dstack.push(c);
                }
            }
        }
        let shadowed: Vec<String> = decl_counts
            .iter()
            .filter(|(nm, c)| **c > counts.get(**nm).copied().unwrap_or(1))
            .map(|(nm, _)| nm.to_string())
            .collect();
        for nm in shadowed {
            targets.remove(&nm);
        }
        if targets.is_empty() {
            return;
        }

        util::emit_value_ref_edges(
            util::ValueRefEmitContext {
                src: self.src,
                node_ids: &self.node_ids,
                arena: &mut self.arena,
                tables: &mut self.tables,
            },
            &scopes,
            &targets,
            MAX_VALUE_REF_NODES,
            &["function_body", "block"],
        );
    }
}
