//! value references for the ccpp/mod extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn scan_capture_children(&mut self, node: Node<'t>, depth: u32) {
        for child in named_children(node) {
            self.scan_fn_ref_subtree(child, depth + 1);
        }
    }

    /// recordCppFnPtrBinding (tree-sitter.ts:5089).
    pub(super) fn record_cpp_fn_ptr_binding(&mut self, local_name: &str, value: Option<Node>) {
        let Some(value) = value else { return };
        if value.kind() != "pointer_expression" {
            return;
        }
        if value.child(0).map(|c| c.kind() != "&").unwrap_or(true) {
            return; // `*p` dereference, not address-of
        }
        let arg = value
            .child_by_field_name("argument")
            .or_else(|| value.named_child(0));
        let Some(arg) = arg else { return };
        if !matches!(
            arg.kind(),
            "identifier" | "template_function" | "qualified_identifier"
        ) {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        let target = strip_cpp_template_args(self.text(arg));
        if target.is_empty() || target == local_name {
            return;
        }
        let targets = self
            .local_fn_ptrs
            .entry(caller_row)
            .or_default()
            .entry(local_name.to_string())
            .or_default();
        if !targets.contains(&target) {
            targets.push(target); // Set semantics, insertion-ordered
        }
    }

    // --- fn-ref capture (#756, cFamilySpec) ----------------------------------

    /// maybeCaptureFnRefs + captureFnRefCandidates for the cFamily dispatch:
    /// argument_list(args), assignment_expression(rhs:right),
    /// init_declarator(varinit:value), initializer_list(list),
    /// initializer_pair(value:value).
    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let mode = match node.kind() {
            "argument_list" => Mode::Args,
            "assignment_expression" => Mode::Rhs,
            "init_declarator" => Mode::Varinit,
            "initializer_list" => Mode::List,
            "initializer_pair" => Mode::Value,
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
        match mode {
            Mode::Args | Mode::List => {
                for child in named_children(node) {
                    values.push(child);
                }
            }
            Mode::Rhs => {
                if let Some(rhs) = node.child_by_field_name("right") {
                    // Param-storage skip: `o->cb = cb` (LHS last name == RHS).
                    let lhs_text = node
                        .child_by_field_name("left")
                        .map(|l| self.text(l))
                        .unwrap_or("");
                    if !util::is_param_storage_assignment(lhs_text, self.text(rhs)) {
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
                // (init_declarator has no name/pattern field — no destructure skip)
                if let Some(v) = node.child_by_field_name("value") {
                    values.push(v);
                }
            }
        }

        for v in values {
            let explicit_ref = v.kind() != "identifier"; // !idTypes.has(type)
            self.normalize_fn_ref_value(v, from, mode, explicit_ref, 0);
        }
    }

    /// normalizeValue for cFamilySpec: bare identifiers, and the
    /// pointer_expression unwrap (`&fn`; `&Cls::m` keeps the qualified name).
    pub(super) fn normalize_fn_ref_value(
        &mut self,
        v: Node<'t>,
        from: u32,
        mode: Mode,
        explicit_ref: bool,
        depth: u32,
    ) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = self.text(v);
                if name.is_empty() || is_stoplisted(name) {
                    return;
                }
                self.push_fn_ref_cand(from, name.to_string(), mode, explicit_ref, v);
            }
            "pointer_expression" => {
                // `&x` is a function value; `*x` is a data read.
                if v.child(0).map(|c| c.kind() != "&").unwrap_or(true) {
                    return;
                }
                let Some(inner) = v.child_by_field_name("argument") else {
                    return;
                };
                if inner.kind() == "qualified_identifier" {
                    let text = self.text(inner).trim();
                    if qualified_ref_re().is_match(text) && !is_stoplisted(text) {
                        self.push_fn_ref_cand(from, text.to_string(), mode, explicit_ref, inner);
                    }
                    return;
                }
                self.normalize_fn_ref_value(inner, from, mode, explicit_ref, depth + 1);
            }
            _ => {}
        }
    }

    pub(super) fn push_fn_ref_cand(
        &mut self,
        from: u32,
        name: String,
        mode: Mode,
        explicit_ref: bool,
        node: Node,
    ) {
        let p = node.start_position();
        self.fn_ref_cands.push(Cand {
            from,
            name,
            mode,
            explicit_ref,
            line: p.row as u32 + 1,
            column_byte: node.start_byte(),
            row: p.row,
        });
    }

    /// scanFnRefSubtree: capture-only walk of subtrees the main walkers skip
    /// (variable-declaration initializers). Halts at nested functions/lambdas.
    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        if depth > 0
            && matches!(
                node.kind(),
                "function_definition"
                    | "arrow_function"
                    | "function_expression"
                    | "lambda_literal"
                    | "lambda_expression"
            )
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        self.scan_capture_children(node, depth);
    }

    /// flushFnRefCandidates with the cFamily gate policy: value/list positions
    /// at FILE scope skip the same-file/import gate (C has no symbol imports);
    /// cpp additionally requires explicit `&` forms outside those positions.
    pub(super) fn flush_fn_ref_candidates(&mut self) {
        let cands = std::mem::take(&mut self.fn_ref_cands);
        if cands.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }
        let address_of_only = self.variant == Variant::Cpp;
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for c in cands {
            let at_file_scope = self.node_ids[c.from as usize].starts_with("file:");
            if address_of_only
                && !c.explicit_ref
                && !(at_file_scope && matches!(c.mode, Mode::Value | Mode::List))
            {
                continue;
            }
            if !util::is_ungated_fn_ref_name(&c.name) {
                let skip_gate = matches!(c.mode, Mode::Value | Mode::List) && at_file_scope;
                if !skip_gate
                    && !util::is_known_fn_ref_name(
                        &c.name,
                        &self.defined_fn_names,
                        &self.imported_names,
                    )
                {
                    continue;
                }
            }
            if !seen.insert((self.node_ids[c.from as usize].clone(), c.name.clone())) {
                continue;
            }
            let column = util::col16(self.src, &self.line_starts, c.row, c.column_byte);
            let name_ref = self.arena.put(&c.name);
            self.push_ref_row(c.from, FUNCTION_REF_CODE, c.line, column, name_ref);
        }
    }

    // --- value refs (C only: VALUE_REF_LANGS has 'c', not 'cpp') -------------

    pub(super) fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if self.variant != Variant::C {
            return;
        }
        if !crate::value_refs_enabled() {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune — the C declarator shape is init_declarator (a
        // file-scope const AND the local that shadows it both count).
        let decl_counts =
            util::count_shadow_declarations(root, MAX_VALUE_REF_NODES, &targets, |node| {
                (node.kind() == "init_declarator")
                    .then(|| c_declarator_identifier(node))
                    .flatten()
                    .filter(|name_node| {
                        matches!(name_node.kind(), "identifier" | "simple_identifier")
                    })
                    .map(|name_node| self.text(name_node).to_string())
            });
        let shadowed = util::shadowed_names(&decl_counts, &counts);
        for nm in shadowed {
            targets.remove(&nm);
        }
        if targets.is_empty() {
            return;
        }

        // (No Dart/Pascal sibling-body pull-in: c/cpp bodies are children.)
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
            &[],
        );
    }
}
