//! value references for the php extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- function-as-value refs (PHP_SPEC, function-ref.ts:360) --------------------

    pub(super) fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        if node.kind() != "arguments" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.normalize_fn_ref_value(c, from, 0);
            }
        }
    }

    pub(super) fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "argument" => {
                for i in 0..v.named_child_count() {
                    if let Some(c) = v.named_child(i) {
                        self.normalize_fn_ref_value(c, from, depth + 1);
                    }
                }
            }
            // String callable — trustworthy ONLY as an argument to a known
            // callable-taking core function; skipGate (resolution's
            // unique-or-drop rule takes over). Namespaced strings drop.
            "string" | "encapsed_string" => {
                let Some(callee) = php_enclosing_call_name(v).map(|f| self.text(f)) else {
                    return;
                };
                if !is_php_callable_hof(callee) {
                    return;
                }
                let Some(content) = self.php_string_content(v) else {
                    return;
                };
                if simple_callable_re().is_match(&content)
                    || qualified_callable_re().is_match(&content)
                {
                    self.push_fn_ref_cand(from, &content, v, true);
                }
            }
            // Array callables in ANY call's arguments: `[$this, 'm']` →
            // this.m; `[Foo::class, 'm']` → Foo::m; `['Cls', 'm']` → nothing.
            "array_creation_expression" => {
                if v.named_child_count() != 2 {
                    return;
                }
                let recv = v.named_child(0).and_then(|e| e.named_child(0));
                let str_el = v.named_child(1).and_then(|e| e.named_child(0));
                let (Some(recv), Some(str_el)) = (recv, str_el) else {
                    return;
                };
                if !matches!(str_el.kind(), "encapsed_string" | "string") {
                    return;
                }
                let Some(member) = self.php_string_content(str_el) else {
                    return;
                };
                if !simple_callable_re().is_match(&member) {
                    return;
                }
                if recv.kind() == "variable_name" && self.text(recv) == "$this" {
                    let name = format!("this.{member}");
                    self.push_fn_ref_cand(from, &name, str_el, false);
                } else if recv.kind() == "class_constant_access_expression" {
                    let cls = recv.named_child(0);
                    let kw = recv.named_child(1);
                    if let (Some(cls), Some(kw)) = (cls, kw) {
                        if self.text(kw) == "class" {
                            let name = format!("{}::{member}", self.text(cls));
                            self.push_fn_ref_cand(from, &name, str_el, false);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node, skip_gate: bool) {
        if name.is_empty() || is_stoplisted(name) {
            return;
        }
        let p = node.start_position();
        self.fn_ref_cands.push(Cand {
            from,
            name: name.to_string(),
            line: p.row as u32 + 1,
            column_byte: node.start_byte(),
            row: p.row,
            skip_gate,
        });
    }

    pub(super) fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // Halts at functionTypes (function_definition) + arrow_function (in
        // the fixed list); anonymous_function is NOT halted — scans descend
        // into closures.
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
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.scan_fn_ref_subtree(c, depth + 1);
            }
        }
    }

    pub(super) fn flush_fn_ref_candidates(&mut self) {
        let cands = std::mem::take(&mut self.fn_ref_cands);
        if cands.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for c in cands {
            // `this.<m>` and `Cls::m` shapes always flush; HOF-position string
            // callables skip the gate (unique-or-drop at resolution); the rest
            // gate on defined-in-file ∪ bare single-segment `use` imports
            // (path-shaped and `::`-shaped import refs match neither regex).
            if !c.name.starts_with("this.") && !c.name.contains("::") {
                let skip = c.skip_gate;
                if !skip
                    && !self.defined_fn_names.contains(&c.name)
                    && !self.imported_names.contains(&c.name)
                {
                    continue;
                }
            }
            if !seen.insert((self.node_ids[c.from as usize].clone(), c.name.clone())) {
                continue;
            }
            let column = util::col16(self.src, &self.line_starts, c.row, c.column_byte);
            let name_ref = self.arena.put(&c.name);
            self.tables.push_ref(&RefRow {
                from_idx: c.from,
                kind: FUNCTION_REF_CODE,
                line: c.line,
                column,
                reference_name: name_ref,
                candidates: NONE_STR,
                from_id_str: NONE_STR,
            });
        }
    }

    // --- value references ------------------------------------------------------------

    pub(super) fn flush_value_refs(&mut self) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let targets = std::mem::take(&mut self.fs_values);
        let _counts = std::mem::take(&mut self.fs_value_counts);
        if !crate::value_refs_enabled() {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune: the per-grammar declarator switch has NO resolving php
        // cases (`assignment` is python's node; property_declaration's
        // Kotlin/Swift path yields null) → declCounts stays empty → no php
        // target is ever pruned. Skipping the scan is byte-identical.

        util::emit_state_value_ref_edges(
            &mut self.state,
            &scopes,
            &targets,
            MAX_VALUE_REF_NODES,
            &[],
        );
    }
}
