//! value references for the csharp extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn capture_value_ref_scope(
        &mut self,
        kind: &'static str,
        name: &str,
        row: u32,
        node: Node<'t>,
    ) {
        let target_kind_ok = kind == "constant" || kind == "variable";
        if target_kind_ok
            && util::utf16_len(name) >= 3
            && util::has_upper_or_underscore().is_match(name)
        {
            let parent_ok = self
                .stack
                .last()
                .map(|scope| util::is_value_ref_scope_kind(scope.kind))
                .unwrap_or(false);
            if parent_ok {
                self.record_value_target(name, row);
            }
        }
        if matches!(kind, "function" | "method" | "constant" | "variable") {
            self.value_scopes.push(ValueScope {
                row,
                node,
                name: name.to_string(),
            });
        }
    }

    pub(super) fn record_value_target(&mut self, name: &str, row: u32) {
        util::record_value_ref_target(
            &mut self.state.fs_values,
            &mut self.state.fs_value_counts,
            name,
            row,
        );
    }

    // --- function-as-value refs (CSHARP_SPEC, function-ref.ts:250) --------------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        #[derive(PartialEq)]
        enum Mode {
            Args,
            Rhs,
            List,
            Varinit,
        }
        let mode = match node.kind() {
            "argument_list" => Mode::Args,
            "assignment_expression" => Mode::Rhs, // covers `+=` event subscription
            "initializer_expression" => Mode::List,
            "variable_declarator" => Mode::Varinit,
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = util::top_scope_row(&self.stack);

        let mut values: Vec<Node> = Vec::new();
        match mode {
            Mode::Args | Mode::List => {
                values.extend(util::named_children(node));
            }
            Mode::Rhs => {
                if let Some(rhs) = node.child_by_field_name("right") {
                    // Param-storage skip: `this.status = status`.
                    let lhs = util::child_by_fields(node, &["left", "lhs", "target"], 0);
                    let lhs_text = lhs.map(|l| util::source_text(self.src, l)).unwrap_or("");
                    let rhs_text = util::source_text(self.src, rhs).trim();
                    if !util::is_param_storage_assignment(lhs_text, rhs_text) {
                        values.push(rhs);
                    }
                }
            }
            Mode::Varinit => {
                // No `value` field on C# variable_declarator: the initializer
                // is the LAST named child — but an initializer-less declarator
                // has its NAME there. Require ≥2 named children and never pick
                // the name child. (Destructuring pattern gate never matches C#.)
                let name_child = node
                    .child_by_field_name("name")
                    .or_else(|| node.child_by_field_name("pattern"));
                let is_destructuring = name_child
                    .map(|nc| {
                        matches!(
                            nc.kind(),
                            "object_pattern" | "array_pattern" | "tuple_pattern" | "struct_pattern"
                        )
                    })
                    .unwrap_or(false);
                if !is_destructuring && node.named_child_count() >= 2 {
                    if let Some(value) = util::field_or_last_named(node, "value") {
                        let is_name = name_child.map(|nc| nc.id() == value.id()).unwrap_or(false);
                        if !is_name {
                            values.push(value);
                        }
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue (function-ref.ts:525) for CSHARP_SPEC: bare identifiers,
    /// the transparent `argument` layer, and the `this.Member` special.
    pub(super) fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = util::source_text(self.src, v);
                self.push_fn_ref_cand(from, name, v);
            }
            "argument" => {
                // Transparent layer (field=null) → recurse all named children.
                for child in util::named_children(v) {
                    self.normalize_fn_ref_value(child, from, depth + 1);
                }
            }
            "member_access_expression" => {
                // `this.Run0` — receiver must be EXACTLY `this` (the vendored
                // grammar yields the anonymous `this` token via the field;
                // text-prefix fallback for field-less shapes). Candidate is
                // the BARE member name at the name node's position.
                let Some(name_node) = v.child_by_field_name("name") else {
                    return;
                };
                let is_this = match v.child_by_field_name("expression") {
                    Some(e) => e.kind() == "this_expression" || e.kind() == "this",
                    None => util::source_text(self.src, v).starts_with("this."),
                };
                if is_this {
                    let name = util::source_text(self.src, name_node);
                    self.push_fn_ref_cand(from, name, name_node);
                }
            }
            _ => {}
        }
    }

    pub(super) fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node) {
        if name.is_empty() || util::is_fn_ref_stoplisted(name) {
            return;
        }
        let p = node.start_position();
        self.fn_ref_cands.push(Cand {
            from,
            name: name.to_string(),
            line: p.row as u32 + 1,
            column_byte: node.start_byte(),
            row: p.row,
        });
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // functionTypes is EMPTY for C#; the literal halt list applies —
        // lambda_expression IS C#'s lambda, so initializer lambdas stop the
        // scan; anonymous_method_expression is NOT listed and scans through.
        if depth > 0
            && matches!(
                node.kind(),
                "arrow_function" | "function_expression" | "lambda_literal" | "lambda_expression"
            )
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        for child in util::named_children(node) {
            self.scan_fn_ref_subtree(child, depth + 1);
        }
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value references --------------------------------------------------------

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

        // Shadow prune: count every variable_declarator declaring a target
        // name (field declarators AND method-body/top-level locals); more
        // declarations than file-scope captures → shadowed → dropped.
        let decl_counts =
            util::count_shadow_declarations(root, MAX_VALUE_REF_NODES, &targets, |node| {
                (node.kind() == "variable_declarator")
                    .then(|| node.named_child(0))
                    .flatten()
                    .filter(|child| child.kind() == "identifier")
                    .map(|child| util::source_text(self.src, child).to_string())
            });
        for nm in util::shadowed_names(&decl_counts, &counts) {
            targets.remove(&nm);
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
