//! value references for the swift extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- function-as-value refs (SWIFT_SPEC, function-ref.ts:288) -------------------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            Rhs,
            List,
            Varinit,
        }
        let mode = match node.kind() {
            "value_arguments" => Mode::Args,
            "assignment" => Mode::Rhs, // field 'result'
            "array_literal" => Mode::List,
            "property_declaration" => Mode::Varinit, // field 'value'
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
                if let Some(rhs) = node.child_by_field_name("result") {
                    // Param-storage skip — swift's LHS field is `target`.
                    let lhs = util::child_by_fields_if_named_count(
                        node,
                        &["left", "lhs", "target"],
                        0,
                        2,
                    );
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                    let rhs_text = self.text(rhs).trim();
                    if !util::is_param_storage_assignment(lhs_text, rhs_text) {
                        values.push(rhs);
                    }
                }
            }
            Mode::Varinit => {
                // Destructuring gate: swift's name field is a `pattern` node —
                // never in the pattern-kind set → never skipped.
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
                if !is_destructuring {
                    if let Some(v) = node.child_by_field_name("value") {
                        values.push(v);
                    }
                }
            }
        }

        self.normalize_fn_ref_values(values, from);
    }

    pub(super) fn normalize_fn_ref_values<I>(&mut self, values: I, from: u32)
    where
        I: IntoIterator<Item = Node<'t>>,
    {
        for value in values {
            self.normalize_fn_ref_value(value, from, 0);
        }
    }

    pub(super) fn emit_value_refs(
        &mut self,
        scopes: &[ValueScope<'t>],
        targets: &HashMap<String, u32>,
    ) {
        util::emit_state_value_ref_edges(
            &mut self.state,
            scopes,
            targets,
            MAX_VALUE_REF_NODES,
            &[],
        );
    }

    pub(super) fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "simple_identifier" => {
                self.push_fn_ref_node(from, v);
            }
            "value_argument" => {
                // Layer with field 'value' + the label-forward skip (the
                // Alamofire A/B finding): label text == value text → dropped.
                let label = v.child_by_field_name("name");
                let value = util::field_or_last_named(v, "value");
                if let (Some(l), Some(val)) = (label, value) {
                    if self.text(l).trim() == self.text(val).trim() {
                        return;
                    }
                }
                if let Some(inner) = v.child_by_field_name("value") {
                    self.normalize_fn_ref_value(inner, from, depth + 1);
                }
            }
            "selector_expression" => {
                // `#selector(fire)` → fire; dotted → rightmost
                // simple_identifier (incl. the `_` quirk); else trimmed text.
                let Some(inner) = v.named_child(0) else {
                    return;
                };
                if matches!(inner.kind(), "identifier" | "simple_identifier") {
                    self.push_fn_ref_node(from, inner);
                    return;
                }
                if let Some(last) = last_simple_identifier(v) {
                    self.push_fn_ref_node(from, last);
                    return;
                }
                let name = self.text(inner).trim().to_string();
                self.push_fn_ref_cand(from, &name, inner);
            }
            _ => {}
        }
    }

    pub(super) fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node) {
        util::record_fn_ref_candidate(&mut self.fn_ref_cands, from, name, node);
    }

    pub(super) fn push_fn_ref_node(&mut self, from: u32, node: Node) {
        let name = self.text(node);
        self.push_fn_ref_cand(from, name, node);
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // Halts at functionTypes (function_declaration) + the fixed list —
        // lambda_literal IS in it (closures halt the scan).
        if depth > 0
            && matches!(
                node.kind(),
                "function_declaration"
                    | "arrow_function"
                    | "function_expression"
                    | "lambda_literal"
                    | "lambda_expression"
            )
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        for c in util::named_children(node) {
            self.scan_fn_ref_subtree(c, depth + 1);
        }
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value references -------------------------------------------------------------

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

        // Shadow prune — TWO cases resolve for swift: property_declaration
        // (firstSimpleIdentifier over the name/binding pattern; guard-let/
        // if-let bindings have no property_declaration → never prune) AND the
        // shared `assignment` case — a declared-then-assigned `let X: T`
        // followed by `X = …` branches counts one bump per assignment (the
        // directly_assignable_expression's simple_identifier child), pruning
        // X exactly as the wasm arm does (caught by the swift-nio sweep).
        let decl_counts =
            util::count_shadow_declarations_many(root, MAX_VALUE_REF_NODES, &targets, |n| {
                let mut names = Vec::new();
                if n.kind() == "assignment" {
                    let left = n
                        .child_by_field_name("left")
                        .or_else(|| n.child_by_field_name("pattern"))
                        .or_else(|| n.named_child(0));
                    if let Some(left) = left {
                        if left.kind() == "identifier" {
                            names.push(self.text(left).to_string());
                        } else {
                            names.extend(
                                util::named_children(left)
                                    .filter(|child| {
                                        matches!(child.kind(), "identifier" | "simple_identifier")
                                    })
                                    .map(|child| self.text(child).to_string()),
                            );
                        }
                    }
                }
                if n.kind() == "property_declaration" {
                    let vd = util::first_named_child_kind(n, "variable_declaration");
                    let id = match vd {
                        Some(vd) => util::first_named_child_kind(vd, "simple_identifier"),
                        None => {
                            first_simple_identifier(n.child_by_field_name("name").or_else(|| {
                                util::first_named_child_kind_any(
                                    n,
                                    &["value_binding_pattern", "pattern"],
                                )
                            }))
                        }
                    };
                    if let Some(id) = id {
                        if matches!(id.kind(), "identifier" | "simple_identifier") {
                            names.push(self.text(id).to_string());
                        }
                    }
                }
                names
            });
        let shadowed = util::shadowed_names(&decl_counts, &counts);
        for nm in shadowed {
            targets.remove(&nm);
        }
        if targets.is_empty() {
            return;
        }

        self.emit_value_refs(&scopes, &targets);
    }
}
