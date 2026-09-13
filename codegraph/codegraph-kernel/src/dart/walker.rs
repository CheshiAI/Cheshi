//! walker for the dart extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind: &str, node: Node) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow {
            from_idx: from_row,
            kind: edge_kind_index(kind).unwrap(),
            line: self.line_of(node),
            column: self.col_of(node),
            reference_name: name_ref,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        // Dart import names are URIs (`package:x/y.dart`) — they match neither
        // SIMPLE_NAME nor QUALIFIED_IMPORT, so importedNames stays empty in
        // practice; ported for fidelity.
        if kind == "imports" {
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    // --- createNode (tree-sitter.ts:1308) ---------------------------------

    pub(super) fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);

        let qualified = {
            let mut parts: Vec<&str> = Vec::new();
            for s in &self.stack {
                if s.kind != "file" {
                    parts.push(&s.name);
                }
            }
            let mut qn = parts.join("::");
            if !qn.is_empty() {
                qn.push_str("::");
            }
            qn.push_str(name);
            qn
        };

        // endLine extension (:1322-1334) — LIVE for dart: a function/method
        // node's endLine extends to its sibling function_body's end.
        let mut end_line = node.end_position().row as u32 + 1;
        if let Some(ext) = extra.end_line_override {
            if ext > end_line {
                end_line = ext;
            }
        }

        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let ret_ref = opt_str(&mut self.arena, extra.return_type.as_deref());
        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
        }
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        let row = self.tables.push_node(&NodeRow {
            kind: node_kind_index(kind).unwrap(),
            visibility: extra.visibility,
            flags,
            start_line,
            end_line,
            start_column: self.col_of(node),
            end_column: self.end_col_of(node),
            name: name_ref,
            qualified_name: qn_ref,
            id: id_ref,
            docstring: doc_ref,
            signature: sig_ref,
            decorators: NONE_STR,
            type_parameters: NONE_STR,
            return_type: ret_ref,
            extra_json: NONE_STR,
        });
        self.node_ids.push(id.clone());
        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }

        let parent_row = self.top_row();
        self.tables.push_edge(&EdgeRow {
            source_idx: parent_row,
            target_idx: row,
            kind: edge_kind_index("contains").unwrap(),
            provenance: 0,
            line: NONE,
            column: NONE,
            metadata_json: NONE_STR,
            source_id_str: NONE_STR,
            target_id_str: NONE_STR,
        });

        // captureValueRefScope (:735-767). Dart mints only `constant` targets.
        if (kind == "constant" || kind == "variable")
            && util::utf16_len(name) >= 3
            && util::has_upper_or_underscore().is_match(name)
        {
            let parent_ok = self
                .stack
                .last()
                .map(|s| matches!(s.kind, "file" | "class" | "module" | "struct" | "enum"))
                .unwrap_or(false);
            if parent_ok {
                self.fs_values.insert(name.to_string(), row);
                *self.fs_value_counts.entry(name.to_string()).or_insert(0) += 1;
            }
        }
        if matches!(kind, "function" | "method" | "constant" | "variable") {
            self.value_scopes.push(ValueScope {
                row,
                node,
                name: name.to_string(),
            });
        }

        Some(row)
    }

    // --- languages/dart.ts helper transcriptions --------------------------

    /// dartInnerSignature (dart.ts:9-17).
    pub(super) fn inner_signature(&self, node: Node<'t>) -> Node<'t> {
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "function_signature" | "getter_signature" | "setter_signature"
                )
            });
            if let Some(inner) = inner {
                return inner;
            }
        }
        node
    }

    /// dartConstructorSignature (dart.ts:25-35).
    pub(super) fn constructor_signature(&self, node: Node<'t>) -> Option<Node<'t>> {
        if matches!(
            node.kind(),
            "factory_constructor_signature" | "constructor_signature"
        ) {
            return Some(node);
        }
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            return node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "factory_constructor_signature" | "constructor_signature"
                )
            });
        }
        None
    }

    /// dartEnclosingTypeName (dart.ts:38-50).
    pub(super) fn enclosing_type_name(&self, node: Node<'t>) -> Option<&'t str> {
        let mut p = node.parent();
        while let Some(parent) = p {
            if matches!(
                parent.kind(),
                "class_definition"
                    | "mixin_declaration"
                    | "extension_declaration"
                    | "enum_declaration"
            ) {
                return parent.child_by_field_name("name").map(|n| self.text(n));
            }
            p = parent.parent();
        }
        None
    }

    /// dartCtorInfo (dart.ts:61-70).
    pub(super) fn ctor_info(&self, node: Node<'t>) -> Option<(String, String)> {
        let ctor = self.constructor_signature(node)?;
        let mut cursor = ctor.walk();
        let ids: Vec<Node<'t>> = ctor
            .named_children(&mut cursor)
            .filter(|c| c.kind() == "identifier")
            .collect();
        let class_name = self.enclosing_type_name(node)?;
        let first = ids.first()?;
        if self.text(*first) != class_name {
            return None; // misparsed method, not a ctor
        }
        let ctor_name = ids.get(1).map(|n| self.text(*n)).unwrap_or(class_name);
        Some((class_name.to_string(), ctor_name.to_string()))
    }

    /// extractDartReturnType (dart.ts:80-92).
    pub(super) fn return_type_of(&self, node: Node<'t>) -> Option<String> {
        if let Some((class_name, _)) = self.ctor_info(node) {
            return Some(class_name);
        }
        let sig = self.inner_signature(node);
        let mut cursor = sig.walk();
        let ret = sig
            .named_children(&mut cursor)
            .find(|c| c.kind() == "type_identifier")?;
        let text = angle_args_re().replace_all(self.text(ret), "");
        let text = text.trim();
        let last = text.split('.').next_back()?;
        if last.is_empty() || !simple_type_name_re().is_match(last) {
            return None;
        }
        Some(last.to_string())
    }

    /// isMisparsedFunction (dart.ts:177-188) — skip the UNNAMED constructor.
    pub(super) fn is_unnamed_ctor(&self, node: Node<'t>) -> bool {
        match self.ctor_info(node) {
            Some((class_name, ctor_name)) => ctor_name == class_name,
            None => false,
        }
    }

    /// getSignature (dart.ts:189-208).
    pub(super) fn signature_of(&self, node: Node<'t>) -> Option<String> {
        let sig = self.inner_signature(node);
        let mut c1 = sig.walk();
        let params = sig
            .named_children(&mut c1)
            .find(|c| c.kind() == "formal_parameter_list");
        let mut c2 = sig.walk();
        let ret = sig
            .named_children(&mut c2)
            .find(|c| matches!(c.kind(), "type_identifier" | "void_type"));
        if params.is_none() && ret.is_none() {
            return None;
        }
        let mut result = String::new();
        if let Some(r) = ret {
            result.push_str(self.text(r));
            result.push(' ');
        }
        if let Some(p) = params {
            result.push_str(self.text(p));
        }
        let trimmed = result.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    /// getVisibility (dart.ts:209-222) — `_` prefix = private; every
    /// constructor is public (the unwrap misses ctor signatures / the name
    /// FIELD is the class identifier).
    pub(super) fn visibility_of(&self, node: Node<'t>) -> u8 {
        let name_node = if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "function_signature" | "getter_signature" | "setter_signature"
                )
            });
            inner.and_then(|i| util::first_named_child_kind(i, "identifier"))
        } else {
            node.child_by_field_name("name")
        };
        match name_node {
            Some(n) if self.text(n).starts_with('_') => 2,
            _ => 1,
        }
    }

    /// isAsync (dart.ts:223-233) — the `async` anon child of the SIBLING
    /// function_body; `async*`/`sync*` are different token types → false.
    pub(super) fn is_async_of(&self, node: Node<'t>) -> bool {
        if let Some(next) = node.next_named_sibling() {
            if next.kind() == "function_body" {
                for i in 0..next.child_count() {
                    if let Some(c) = next.child(i) {
                        if c.kind() == "async" {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// isStatic (dart.ts:234-243).
    pub(super) fn is_static_of(&self, node: Node<'t>) -> bool {
        if node.kind() == "method_signature" {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "static" {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// resolveBody (dart.ts:158-171).
    pub(super) fn resolve_body(&self, node: Node<'t>) -> Option<Node<'t>> {
        if matches!(node.kind(), "function_signature" | "method_signature") {
            let next = node.next_named_sibling()?;
            if next.kind() == "function_body" {
                return Some(next);
            }
            return None;
        }
        if let Some(standard) = node.child_by_field_name("body") {
            return Some(standard);
        }
        let mut cursor = node.walk();
        let found = node
            .named_children(&mut cursor)
            .find(|c| matches!(c.kind(), "class_body" | "extension_body"));
        found
    }

    /// extractName (tree-sitter.ts:90-192) — resolveName (ctor names) →
    /// name field → the method_signature inner unwrap → identifier-ish
    /// child → `<anonymous>` (operators land here).
    pub(super) fn extract_name(&self, node: Node<'t>) -> String {
        // resolveName hook (dart.ts:244-260): named ctor/factory → ctor name.
        if let Some((class_name, ctor_name)) = self.ctor_info(node) {
            if ctor_name != class_name {
                return ctor_name;
            }
        }
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "function_signature"
                        | "getter_signature"
                        | "setter_signature"
                        | "constructor_signature"
                        | "factory_constructor_signature"
                )
            });
            if let Some(inner) = inner {
                let mut ic = inner.walk();
                let id = inner
                    .named_children(&mut ic)
                    .find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    return self.text(id).to_string();
                }
            }
        }
        let mut cursor = node.walk();
        for c in node.named_children(&mut cursor) {
            if matches!(
                c.kind(),
                "identifier" | "type_identifier" | "simple_identifier" | "constant"
            ) {
                return self.text(c).to_string();
            }
        }
        "<anonymous>".to_string()
    }

    // --- the main walk (visitNode, tree-sitter.ts:936-1303) ---------------

    pub(super) fn visit(&mut self, node: Node<'t>) {
        // The visitNode hook (dart.ts:144-157) — the constants branch.
        if node.kind() == "static_final_declaration" {
            let mut cursor = node.walk();
            let name_node = node
                .named_children(&mut cursor)
                .find(|c| c.kind() == "identifier");
            if let Some(name_node) = name_node {
                // signature = first value sibling's text, sliced to 100
                // UTF-16 units (a flattened chain captures just its head).
                let signature = name_node.next_named_sibling().map(|v| {
                    let (sliced, _) = util::slice_utf16(self.text(v), 100);
                    if util::utf16_len(&sliced) >= 100 {
                        format!("= {sliced}...")
                    } else {
                        format!("= {sliced}")
                    }
                });
                let name = self.text(name_node).to_string();
                self.create_node(
                    "constant",
                    &name,
                    node,
                    Extra {
                        signature,
                        ..Default::default()
                    },
                );
            }
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

        // maybeCaptureFnRefs (:990) — the double-walk fn-ref twin source.
        self.maybe_capture_fn_refs(node);

        match node.kind() {
            "function_signature" => {
                // functionTypes row — method_signature does NOT include it →
                // always extractFunction, even inside a class (abstract
                // members become kind `function` contained by the class).
                self.extract_function(node);
                return;
            }
            "class_definition" | "mixin_declaration" | "extension_declaration" => {
                self.extract_class(node);
                return;
            }
            "method_signature" | "constructor_signature" => {
                self.extract_method(node);
                return;
            }
            "enum_declaration" => {
                self.extract_enum(node);
                return;
            }
            "type_alias" => {
                let skip = self.extract_type_alias(node);
                if skip {
                    return;
                }
            }
            "import_or_export" => {
                self.extract_import(node);
                return;
            }
            "new_expression" => {
                // INSTANTIATION_KINDS row — from the FILE/CLASS on the
                // sibling revisit (the double-walk's pass 2a).
                self.extract_instantiation(node);
            }
            _ => {}
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
    }

    // --- visitFunctionBody (:5129-5286) — dart rows -----------------------

    pub(super) fn visit_body(&mut self, node: Node<'t>) {
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        if kind == "new_expression" {
            // INSTANTIATION branch fires first — extractBareCall's
            // new_expression arm is dead. Children still recursed.
            self.extract_instantiation(node);
        } else if let Some(callee) = self.bare_call_name(node) {
            // extractBareCall (:5159-5173) — ref at the MATCHED node.
            if !self.stack.is_empty() {
                let caller_row = self.top_row();
                self.push_ref_at(caller_row, &callee, "calls", node);
            }
        }

        self.extract_static_member_ref(node);

        if kind == "function_signature" {
            // Nested named functions (:5245) — extractFunction walks the
            // nested body itself; the enclosing walker ALSO revisits the
            // sibling function_body (double-walk pass 2b) via recursion.
            self.extract_function(node);
            return;
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit_body(child);
        }
    }
}
