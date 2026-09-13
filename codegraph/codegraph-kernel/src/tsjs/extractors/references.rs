//! references for the tsjs/extractors extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractImport + binding refs ---------------------------------------------------

    pub(in crate::tsjs) fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        // typescriptExtractor.extractImport: the `source` field, quotes stripped
        // globally. A missing/empty module means the hook declined — no node.
        let Some(source_field) = node.child_by_field_name("source") else {
            return;
        };
        let module_name: String = self
            .text(source_field)
            .chars()
            .filter(|c| *c != '\'' && *c != '"')
            .collect();
        if module_name.is_empty() {
            return;
        }
        self.create_node(
            "import",
            &module_name,
            node,
            Extra {
                signature: Some(import_text),
                ..Extra::default()
            },
        );
        let parent = self.top_row();
        self.push_ref(
            parent,
            &module_name.clone(),
            edge_kind_index("imports").unwrap(),
            node,
        );
        self.emit_import_binding_refs(node, parent);
    }

    pub(super) fn emit_import_binding_refs(&mut self, node: Node<'t>, from_row: u32) {
        let clause = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "import_clause");
        let Some(clause) = clause else { return }; // side-effect import

        let imports_kind = edge_kind_index("imports").unwrap();
        let push = |w: &mut Self, name_node: Option<Node>| {
            let Some(n) = name_node else { return };
            let name = w.text(n).to_string();
            if name.is_empty() {
                return;
            }
            w.push_ref(from_row, &name, imports_kind, n);
        };

        for i in 0..clause.named_child_count() {
            let Some(child) = clause.named_child(i) else {
                continue;
            };
            match child.kind() {
                "identifier" => push(self, Some(child)),
                "named_imports" => {
                    for j in 0..child.named_child_count() {
                        let Some(spec) = child.named_child(j) else {
                            continue;
                        };
                        if spec.kind() != "import_specifier" {
                            continue;
                        }
                        let n = spec
                            .child_by_field_name("alias")
                            .or_else(|| spec.child_by_field_name("name"))
                            .or_else(|| spec.named_child(0));
                        push(self, n);
                    }
                }
                "namespace_import" => {
                    let n = (0..child.named_child_count())
                        .filter_map(|k| child.named_child(k))
                        .find(|c| c.kind() == "identifier")
                        .or_else(|| child.named_child(0));
                    push(self, n);
                }
                _ => {}
            }
        }
    }

    pub(in crate::tsjs) fn emit_re_export_refs(&mut self, node: Node<'t>) {
        let from_row = self.top_row();
        let clause = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "export_clause");
        let Some(clause) = clause else { return }; // `export * from './y'`
        let imports_kind = edge_kind_index("imports").unwrap();
        for i in 0..clause.named_child_count() {
            let Some(spec) = clause.named_child(i) else {
                continue;
            };
            if spec.kind() != "export_specifier" {
                continue;
            }
            let name_node = spec
                .child_by_field_name("name")
                .or_else(|| spec.named_child(0));
            let Some(n) = name_node else { continue };
            let name = self.text(n).to_string();
            if name.is_empty() || name == "default" {
                continue;
            }
            self.push_ref(from_row, &name, imports_kind, n);
        }
    }

    // --- extractCall (TS/JS generic tail) -------------------------------------------------

    pub(in crate::tsjs) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let mut callee_name = String::new();

        if let Some(func) = func {
            if func.kind() == "member_expression" {
                let property = util::child_by_fields(func, &["property", "field"], 1);
                if let Some(property) = property {
                    let method_name = self.text(property);
                    let receiver =
                        util::child_by_fields(func, &["object", "operand", "argument"], 0);
                    // Literal receivers call builtins, never project symbols (#1230).
                    if let Some(r) = receiver {
                        if is_literal_receiver(r.kind()) {
                            return;
                        }
                    }
                    if let Some(r) = receiver {
                        // Keep field/factory chains and `this` distinct from
                        // bare calls so resolution cannot guess another class.
                        let receiver_name: String = self.text(r).chars()
                            .filter(|c| !c.is_whitespace()).collect();
                        callee_name = format!("{receiver_name}.{method_name}");
                    } else {
                        callee_name = method_name.to_string();
                    }
                }
            } else {
                callee_name = self.text(func).to_string();
            }
        }

        // Parenthesized-callee normalization (`(fn)()` → fn).
        callee_name = util::normalize_parenthesized_name(&callee_name);

        if !callee_name.is_empty() {
            self.push_call_ref(&callee_name.clone(), node);
        }
    }

    // --- extractInstantiation -----------------------------------------------------------

    pub(in crate::tsjs) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let ctor = util::child_by_fields(node, &["constructor", "type", "name"], 0);
        let Some(ctor) = ctor else { return };

        let class_name = util::strip_generic_and_qualifier(self.text(ctor));
        if !class_name.is_empty() {
            let from = self.top_row();
            self.push_ref(
                from,
                &class_name,
                edge_kind_index("instantiates").unwrap(),
                node,
            );
        }
    }

    // --- extractDecoratorsFor --------------------------------------------------------------

    pub(in crate::tsjs) fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        // 1. Direct children (method/property style).
        for child in util::named_children(decl) {
            self.consider_decorator(child, decorated_row);
            if child.kind() == "modifiers" {
                for modifier in util::named_children(child) {
                    self.consider_decorator(modifier, decorated_row);
                }
            }
        }
        // 2. Preceding siblings (TypeScript class style), stopping at the
        //    first non-decorator so an earlier declaration's decorators never
        //    leak in. Matching by startIndex, not object identity.
        let Some(parent) = decl.parent() else { return };
        let decl_start = decl.start_byte();
        let decl_idx = util::named_children(parent)
            .enumerate()
            .find_map(|(index, sibling)| (sibling.start_byte() == decl_start).then_some(index));
        if let Some(decl_idx) = decl_idx {
            if decl_idx == 0 {
                return;
            }
            for sibling in util::preceding_named_children(parent, decl_idx) {
                let sib = sibling;
                if !matches!(sib.kind(), "decorator" | "annotation" | "marker_annotation") {
                    break;
                }
                self.consider_decorator(sib, decorated_row);
            }
        }
    }

    pub(super) fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        if !matches!(
            n.kind(),
            "decorator" | "annotation" | "marker_annotation" | "attribute"
        ) {
            return;
        }
        let mut target: Option<Node> = None;
        for child in util::named_children(n) {
            if child.kind() == "call_expression" {
                target = util::child_by_fields(child, &["function"], 0);
                if target.is_some() {
                    break;
                }
            }
            if matches!(
                child.kind(),
                "identifier"
                    | "member_expression"
                    | "scoped_identifier"
                    | "navigation_expression"
                    | "user_type"
                    | "type_identifier"
            ) {
                target = Some(child);
                break;
            }
        }
        let Some(target) = target else { return };
        let name = util::strip_generic_and_qualifier(self.text(target));
        if name.is_empty() {
            return;
        }
        self.push_ref(
            decorated_row,
            &name,
            edge_kind_index("decorates").unwrap(),
            n,
        );
    }

    // --- extractInheritance (TS/JS clauses) ---------------------------------------------------

    pub(in crate::tsjs) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        let implements_kind = edge_kind_index("implements").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            match child.kind() {
                // TS `extends_clause` (the other spellings are other grammars').
                "extends_clause" | "superclass" | "base_clause" | "extends_interfaces" => {
                    if let Some(target) = child.named_child(0) {
                        let name = self.text(target).to_string();
                        self.push_ref(class_row, &name, extends_kind, target);
                    }
                }
                "implements_clause"
                | "class_interface_clause"
                | "super_interfaces"
                | "interfaces" => {
                    for j in 0..child.named_child_count() {
                        if let Some(iface) = child.named_child(j) {
                            let name = self.text(iface).to_string();
                            self.push_ref(class_row, &name, implements_kind, iface);
                        }
                    }
                }
                // JS `class Foo extends Bar` — class_heritage holds a bare
                // identifier without an extends_clause wrapper.
                "identifier" | "type_identifier" if node.kind() == "class_heritage" => {
                    let name = self.text(child).to_string();
                    self.push_ref(class_row, &name, extends_kind, child);
                }
                // TS class_heritage wraps extends/implements — recurse.
                "field_declaration_list" | "class_heritage" => {
                    self.extract_inheritance(child, class_row);
                }
                _ => {}
            }
        }
    }

    // --- type annotations (#381 — TS family only) ----------------------------------------------

    pub(in crate::tsjs) fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if !self.variant.is_ts() {
            return;
        }
        if let Some(params) = node.child_by_field_name("parameters") {
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("return_type") {
            self.extract_type_refs_from_subtree(ret, from_row);
        }
        let type_annotation = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = type_annotation {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    pub(in crate::tsjs) fn extract_variable_type_annotation(
        &mut self,
        node: Node<'t>,
        from_row: u32,
    ) {
        if !self.variant.is_ts() {
            return;
        }
        let type_annotation = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = type_annotation {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    pub(super) fn extract_type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        if node.kind() == "type_identifier" {
            let type_name = self.text(node).to_string();
            if !type_name.is_empty() && !is_builtin_type(&type_name) {
                self.push_ref(
                    from_row,
                    &type_name,
                    edge_kind_index("references").unwrap(),
                    node,
                );
            }
            return;
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.extract_type_refs_from_subtree(c, from_row);
            }
        }
    }
}
