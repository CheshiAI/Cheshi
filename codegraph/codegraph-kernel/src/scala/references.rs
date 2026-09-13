//! references for the scala extractor.

use super::*;

impl<'t> Walker<'t> {
    /// emitScalaTypeRefs (scala.ts:27-45) — the hook's own builtin set.
    pub(super) fn emit_scala_type_refs(&mut self, type_node: Node<'t>, from_row: u32) {
        if type_node.kind() == "type_identifier" {
            let name = self.text(type_node);
            if !name.is_empty() && !is_scala_builtin(name) {
                let name = name.to_string();
                self.push_ref_at(from_row, &name, "references", type_node);
            }
            return;
        }
        for c in util::named_subtree_preorder(type_node).into_iter().skip(1) {
            if c.kind() == "type_identifier" {
                let name = self.text(c);
                if !name.is_empty() && !is_scala_builtin(name) {
                    let name = name.to_string();
                    self.push_ref_at(from_row, &name, "references", c);
                }
            }
        }
    }

    // --- extractImport (:3170-3236) ---------------------------------------

    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim();
        // extractImport hook (scala.ts:200-211): `path` field is FIRST-MATCH-
        // WINS → the FIRST dotted segment names the import.
        let module = if let Some(path) = node.child_by_field_name("path") {
            Some(self.text(path))
        } else {
            util::first_named_child_kind_any(node, &["identifier", "stable_identifier"])
                .map(|child| self.text(child))
        };
        let Some(module) = module else { return };
        let module = module.to_string();
        let signature = import_text.to_string();
        let created = self.create_node(
            "import",
            &module,
            node,
            Extra {
                signature: Some(signature),
                ..Default::default()
            },
        );
        // Generic imports ref (:3183-3194) — hook sets no handledRefs.
        if created.is_some() && !module.is_empty() && !self.stack.is_empty() {
            let parent_row = self.top_row();
            self.push_ref_at(parent_row, &module, "imports", node);
        }
    }

    // --- extractCall (:3684) ----------------------------------------------

    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };

        let mut callee: Option<String> = None;
        if func.kind() == "field_expression" {
            // Member branch (:4364): property = `field` field for scala.
            let property = func
                .child_by_field_name("property")
                .or_else(|| func.child_by_field_name("field"))
                .or_else(|| func.named_child(1));
            if let Some(property) = property {
                let method_name = self.text(property);
                let receiver = util::child_by_fields(func, &["object", "operand", "argument"], 0);
                if let Some(receiver) = receiver {
                    if is_literal_receiver(receiver.kind()) {
                        return; // literal receivers emit NOTHING (#1230)
                    }
                    if matches!(
                        receiver.kind(),
                        "identifier" | "simple_identifier" | "field_identifier"
                    ) {
                        let recv_name = self.text(receiver);
                        if matches!(recv_name, "self" | "this" | "cls" | "super") {
                            callee = Some(method_name.to_string());
                        } else {
                            callee = Some(format!("{recv_name}.{method_name}"));
                        }
                    } else if receiver.kind() == "call_expression" {
                        // The #750 re-encode, scala arm (:4443-4464): inner
                        // callee via the REAL `function` field; re-encode only
                        // capitalized (companion-factory / apply) chains.
                        let inner_fn = receiver.child_by_field_name("function");
                        let inner_callee = inner_fn
                            .map(|f| {
                                let t = self.text(f).replace("->", ".");
                                ws_re().replace_all(&t, "").into_owned()
                            })
                            .unwrap_or_default();
                        let reencode = starts_upper_re().is_match(&inner_callee);
                        callee = Some(if reencode {
                            format!("{inner_callee}().{method_name}")
                        } else {
                            method_name.to_string()
                        });
                    } else {
                        callee = Some(method_name.to_string());
                    }
                } else {
                    callee = Some(method_name.to_string());
                }
            }
        } else {
            // Else branch (:4518-4520): RAW func text (apply-sugar `WidgetS`,
            // `genericCall[Int]` type args kept, curried `curried(1)` inners).
            callee = Some(self.text(func).to_string());
        }

        let Some(mut callee) = callee else { return };
        // Parenthesized-conversion (:4529-4532).
        if let Some(caps) = util::paren_conversion().captures(&callee) {
            if let Some(inner) = caps.get(1) {
                callee = inner.as_str().to_string();
            }
        }
        if callee.is_empty() {
            return;
        }
        self.push_ref_at(caller_row, &callee, "calls", node);
    }

    // --- extractInstantiation (:4610, scala arm :4647-4662) ---------------

    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let from_row = self.top_row();
        let ctor = util::child_by_fields(node, &["constructor", "type", "name"], 0);
        let Some(ctor) = ctor else { return };
        if let Some(name) = self.scala_base_type_name(Some(ctor)) {
            self.push_ref_at(from_row, &name, "instantiates", node);
        }
    }

    // --- extractStaticMemberRef (:4750-4808) ------------------------------

    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let owner_row = self.top_row();
        // MEMBER_ACCESS_TYPES — only field_expression occurs in scala trees.
        if !matches!(
            node.kind(),
            "field_access"
                | "member_access_expression"
                | "navigation_expression"
                | "field_expression"
                | "class_constant_access_expression"
                | "scoped_property_access_expression"
                | "qualified_identifier"
        ) {
            return;
        }
        // Callee-of-call skip: `Type.method()`'s callee access is already a
        // calls ref.
        if util::is_call_callee(node) {
            return;
        }
        let recv = util::child_by_fields(node, &["object", "expression", "scope"], 0);
        let Some(recv) = recv else { return };
        if matches!(
            recv.kind(),
            "identifier"
                | "type_identifier"
                | "simple_identifier"
                | "name"
                | "scoped_type_identifier"
        ) {
            let text = self.text(recv);
            if cap_ident_re().is_match(text) {
                let text = text.to_string();
                self.push_ref_at(owner_row, &text, "references", recv);
            }
        }
    }

    // --- extractDecoratorsFor (:4897-5024) --------------------------------

    pub(super) fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for decorator in util::decorator_nodes(decl) {
            if let Some(name) = util::decorator_name(decorator, self.src) {
                self.push_ref_at(decorated_row, &name, "decorates", decorator);
            }
        }
    }

    // --- extractInheritance — the scala branch (:5339-5360) ---------------

    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        for child in util::named_children(node) {
            if matches!(
                child.kind(),
                "extends_clause" | "superclass" | "base_clause" | "extends_interfaces"
            ) {
                // Iterate ALL supertypes (with-chains, comma form); unwrap
                // each via scalaBaseTypeName; `arguments` children → None →
                // skipped. `derives_clause` is a different kind — silent.
                for target in util::named_children(child) {
                    if let Some(name) = self.scala_base_type_name(Some(target)) {
                        self.push_ref_at(class_row, &name, "extends", target);
                    }
                }
            }
        }
    }

    // --- extractTypeAnnotations (:5788-5880) ------------------------------

    pub(super) fn extract_type_annotations(&mut self, node: Node<'t>, row: u32) {
        // Scala walks EVERY `parameters`-TYPE child (all curried lists; the
        // type_parameters node is a different kind, matched by walk 3).
        let kids: Vec<Node<'t>> = util::named_children(node).collect();
        for pc in &kids {
            if pc.kind() == "parameters" {
                self.type_refs_from_subtree(*pc, row);
            }
        }
        if let Some(rt) = node.child_by_field_name("return_type") {
            self.type_refs_from_subtree(rt, row);
        }
        // Context/upper bounds: the first type_parameters child.
        if let Some(tp) = kids.iter().find(|c| c.kind() == "type_parameters") {
            self.type_refs_from_subtree(*tp, row);
        }
        // Direct type_annotation child — no such scala kind; ported cheaply.
        if let Some(ta) = kids.iter().find(|c| c.kind() == "type_annotation") {
            self.type_refs_from_subtree(*ta, row);
        }
    }

    pub(super) fn type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        for candidate in util::named_subtree_preorder(node) {
            if candidate.kind() != "type_identifier" {
                continue;
            }
            let name = self.text(candidate);
            if !name.is_empty() && !is_builtin_type(name) {
                let name = name.to_string();
                self.push_ref_at(from_row, &name, "references", candidate);
            }
        }
    }
}
