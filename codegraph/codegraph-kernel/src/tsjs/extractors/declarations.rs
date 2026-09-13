//! declarations for the tsjs/extractors extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn declaration_extra(&self, node: Node, include_visibility: bool) -> Extra {
        Extra {
            docstring: crate::docstring::preceding_docstring(node, self.src),
            visibility: include_visibility
                .then(|| self.visibility_of(node))
                .flatten(),
            is_exported: Some(self.is_exported(node)),
            ..Extra::default()
        }
    }

    // --- extractFunction --------------------------------------------------------

    pub(in crate::tsjs) fn extract_function(
        &mut self,
        node: Node<'t>,
        name_override: Option<String>,
    ) {
        let mut name = name_override
            .clone()
            .unwrap_or_else(|| self.extract_name(node));

        // Arrow/function-expression values: resolve the name from the parent
        // variable_declarator (`export const useAuth = () => {}`).
        if name_override.is_none()
            && name == "<anonymous>"
            && matches!(node.kind(), "arrow_function" | "function_expression")
        {
            if let Some(parent) = node.parent() {
                if parent.kind() == "variable_declarator" {
                    if let Some(var_name) = parent.child_by_field_name("name") {
                        name = self.text(var_name).to_string();
                    }
                }
            }
        }
        if name == "<anonymous>" {
            // Still walk the body: module wrappers hold named inner functions
            // and calls that would otherwise be lost (#528).
            if let Some(body) = body_of(node) {
                self.visit_function_body(body);
            }
            return;
        }

        let extra = Extra {
            docstring: crate::docstring::preceding_docstring(node, self.src),
            signature: self.signature_of(node),
            visibility: self.visibility_of(node),
            is_exported: Some(self.is_exported(node)),
            is_async: Some(self.is_async(node)),
            is_static: self.is_static(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };

        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);

        self.stack.push(Scope {
            row,
            kind: "function",
            name,
        });
        if let Some(body) = body_of(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    // --- extractClass ------------------------------------------------------------

    pub(in crate::tsjs) fn extract_class(&mut self, node: Node<'t>) {
        let resolved_body = body_of(node); // skipBodilessClass unset for TS/JS
        let name = self.extract_name(node);
        let extra = self.declaration_extra(node, true);
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };

        self.extract_inheritance(node, row);
        self.extract_decorators_for(node, row);

        self.stack.push(Scope {
            row,
            kind: "class",
            name,
        });
        let body = resolved_body.unwrap_or(node);
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        self.stack.pop();
    }

    // --- extractMethod -------------------------------------------------------------

    pub(in crate::tsjs) fn extract_method(&mut self, node: Node<'t>) {
        if !self.inside_class_like() {
            // Object-literal methods are ephemeral: walk the body only.
            if let Some(parent) = node.parent() {
                if matches!(parent.kind(), "object" | "object_expression") {
                    if let Some(body) = body_of(node) {
                        self.visit_function_body(body);
                    }
                    return;
                }
            }
            self.extract_function(node, None);
            return;
        }

        let name = self.extract_name(node);
        let extra = Extra {
            docstring: crate::docstring::preceding_docstring(node, self.src),
            signature: self.signature_of(node),
            visibility: self.visibility_of(node),
            is_async: Some(self.is_async(node)),
            is_static: self.is_static(node),
            ..Extra::default() // methods carry no isExported (mirrors extractMethod)
        };
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };

        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);

        self.stack.push(Scope {
            row,
            kind: "method",
            name,
        });
        if let Some(body) = body_of(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    // --- extractInterface / extractEnum / members -----------------------------------

    pub(in crate::tsjs) fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = self.declaration_extra(node, false);
        let Some(row) = self.create_node("interface", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.stack.push(Scope {
            row,
            kind: "interface",
            name,
        });
        let body = body_of(node).unwrap_or(node);
        for child in util::named_children(body) {
            self.visit_node(child);
        }
        self.stack.pop();
    }

    pub(in crate::tsjs) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = body_of(node) else { return };
        let name = self.extract_name(node);
        let extra = self.declaration_extra(node, true);
        let Some(row) = self.create_node("enum", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.stack.push(Scope {
            row,
            kind: "enum",
            name,
        });
        for child in util::named_children(body) {
            if matches!(child.kind(), "property_identifier" | "enum_assignment") {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    pub(super) fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
            return;
        }
        let mut found = false;
        for child in util::named_children(node) {
            if matches!(
                child.kind(),
                "simple_identifier" | "identifier" | "property_identifier"
            ) {
                let name = self.text(child).to_string();
                self.create_node("enum_member", &name, child, Extra::default());
                found = true;
            }
        }
        if !found && node.named_child_count() == 0 {
            let name = self.text(node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    // --- extractProperty (#808 property-classified class fields) ---------------------

    pub(in crate::tsjs) fn extract_property(&mut self, node: Node<'t>) -> Option<(u32, String)> {
        let docstring = crate::docstring::preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let is_static = Some(self.is_static(node).unwrap_or(false)); // `?? false` — always present

        let name_node = node
            .child_by_field_name("name")
            .or_else(|| node.child_by_field_name("property"))
            .or_else(|| util::first_named_child_kind(node, "identifier"))?;
        let name = self.text(name_node).to_string();

        // TS/JS field definitions carry an explicit `type` field; the generic
        // scan is for other languages (#808).
        let type_text = node.child_by_field_name("type").map(|t| {
            let raw = self.text(t);
            raw.strip_prefix(':')
                .unwrap_or(raw)
                .trim_start()
                .to_string()
        });
        let signature = match &type_text {
            Some(t) => format!("{t} {name}"),
            None => name.clone(),
        };

        let row = self.create_node(
            "property",
            &name,
            node,
            Extra {
                docstring,
                signature: Some(signature),
                visibility,
                is_static,
                ..Extra::default()
            },
        )?;
        self.extract_decorators_for(node, row);
        self.extract_type_annotations(node, row);
        Some((row, name))
    }

    // --- extractVariable (TS/JS branch) ------------------------------------------------

    pub(in crate::tsjs) fn extract_variable(&mut self, node: Node<'t>) {
        let is_const = self.is_const_decl(node);
        let kind: &'static str = if is_const { "constant" } else { "variable" };
        let docstring = crate::docstring::preceding_docstring(node, self.src);
        let is_exported = self.is_exported(node); // `?? false` — always present

        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            if child.kind() != "variable_declarator" {
                continue;
            }
            let Some(name_node) = child.child_by_field_name("name") else {
                continue;
            };
            let value = child.child_by_field_name("value");

            // Destructured patterns are skipped — except RTK Query generated
            // hooks (`export const { useGetXQuery } = api`).
            if matches!(name_node.kind(), "object_pattern" | "array_pattern") {
                if name_node.kind() == "object_pattern"
                    && value.map(|v| v.kind() == "identifier").unwrap_or(false)
                {
                    self.extract_rtk_hook_bindings(name_node, is_exported);
                }
                continue;
            }
            let name = self.text(name_node).to_string();

            // Arrow/function values extract as functions, named by the declarator.
            if let Some(v) = value {
                if matches!(v.kind(), "arrow_function" | "function_expression") {
                    self.extract_function(v, None);
                    continue;
                }
            }

            let init_signature = value.map(|v| util::init_signature(self.text(v)));

            // React HOC-wrapped components (#841), PascalCase-gated.
            if let Some(v) = value {
                if util::pascal_case().is_match(&name) {
                    if let Some(inner) = self.react_component_hoc(v) {
                        self.extract_react_component_node(
                            &name,
                            child,
                            inner,
                            Extra {
                                docstring: docstring.clone(),
                                signature: init_signature.clone(),
                                is_exported: Some(is_exported),
                                ..Extra::default()
                            },
                        );
                        continue;
                    }
                }
            }

            let var_row = self.create_node(
                kind,
                &name,
                child,
                Extra {
                    docstring: docstring.clone(),
                    signature: init_signature.clone(),
                    is_exported: Some(is_exported),
                    ..Extra::default()
                },
            );
            if let Some(row) = var_row {
                self.extract_variable_type_annotation(child, row);
            }

            // Exported const object-of-functions / store shapes.
            let object_of_fns: Option<Node> = match value {
                Some(v) if matches!(v.kind(), "object" | "object_expression") => Some(v),
                Some(v) if v.kind() == "call_expression" => {
                    self.find_initializer_returned_object(v, 0)
                }
                _ => None,
            };
            let has_inline_fns = object_of_fns
                .map(|o| self.object_has_inline_functions(o))
                .unwrap_or(false);
            let extract_object_methods = is_exported && object_of_fns.is_some() && has_inline_fns;

            let rtk_endpoints = match value {
                Some(v) if v.kind() == "call_expression" => self.find_rtk_endpoints_object(v),
                _ => None,
            };
            let pinia_setup = match value {
                Some(v) if v.kind() == "call_expression" => self.find_pinia_setup_fn(v),
                _ => None,
            };
            let mut store_collections: Vec<Node> = Vec::new();
            if let Some(v) = value {
                if matches!(v.kind(), "call_expression" | "new_expression") {
                    store_collections.extend(self.find_vue_store_collection_objects(v));
                }
            }
            if let Some(obj) = object_of_fns {
                if !extract_object_methods
                    && is_vue_collection_name(&name)
                    && self.looks_like_vue_store_file()
                {
                    store_collections.push(obj);
                }
            }

            // Walk the initializer for calls — except the object/store shapes
            // whose members are extracted method-by-method below.
            if let Some(v) = value {
                let vk = v.kind();
                if vk != "object"
                    && vk != "object_expression"
                    && !(extract_object_methods && vk == "call_expression")
                    && rtk_endpoints.is_none()
                    && pinia_setup.is_none()
                    && store_collections.is_empty()
                {
                    self.visit_function_body(v);
                }
            }

            if extract_object_methods {
                if let Some(obj) = object_of_fns {
                    self.extract_object_literal_functions(obj);
                }
            }
            if let Some(rtk) = rtk_endpoints {
                self.extract_rtk_endpoints(rtk);
            }
            if let Some(setup) = pinia_setup {
                self.extract_pinia_setup_body(setup);
            }
            for coll in store_collections {
                self.extract_object_literal_functions(coll);
            }
        }
    }

    // --- extractTypeAlias + members (#359, #634) -------------------------------------

    /// Returns skipChildren (always false on the TS path — the alias value is
    /// still traversed by the dispatcher).
    pub(in crate::tsjs) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let extra = self.declaration_extra(node, false);
        let Some(row) = self.create_node("type_alias", &name, node, extra) else {
            return false;
        };
        if let Some(value) = node.child_by_field_name("value") {
            self.extract_type_refs_from_subtree(value, row);
            self.extract_ts_type_alias_members(value, row, &name);
            self.extract_ts_tuple_contract_names(value, row, &name);
        }
        false
    }

    pub(super) fn extract_ts_type_alias_members(
        &mut self,
        value: Node<'t>,
        alias_row: u32,
        alias_name: &str,
    ) {
        let mut object_types: Vec<Node> = Vec::new();
        if value.kind() == "object_type" {
            object_types.push(value);
        } else if value.kind() == "intersection_type" {
            for i in 0..value.named_child_count() {
                if let Some(op) = value.named_child(i) {
                    if op.kind() == "object_type" {
                        object_types.push(op);
                    }
                }
            }
        } else {
            return;
        }

        self.stack.push(Scope {
            row: alias_row,
            kind: "type_alias",
            name: alias_name.to_string(),
        });
        for obj_type in object_types {
            for i in 0..obj_type.named_child_count() {
                let Some(child) = obj_type.named_child(i) else {
                    continue;
                };
                if !matches!(child.kind(), "property_signature" | "method_signature") {
                    continue;
                }
                let Some(name_node) = child.child_by_field_name("name") else {
                    continue;
                };
                let member_name = self.text(name_node).to_string();
                if member_name.is_empty() {
                    continue;
                }
                let member_kind: &'static str = if child.kind() == "method_signature"
                    || self.is_ts_function_typed_property(child)
                {
                    "method"
                } else {
                    "property"
                };
                let extra = Extra {
                    docstring: crate::docstring::preceding_docstring(child, self.src),
                    signature: Some(self.text(child).to_string()),
                    qualified_name: Some(format!("{alias_name}::{member_name}")),
                    ..Extra::default()
                };
                self.create_node(member_kind, &member_name, child, extra);
                self.extract_type_annotations(child, alias_row);
            }
        }
        self.stack.pop();
    }

    pub(super) fn extract_ts_tuple_contract_names(
        &mut self,
        value: Node<'t>,
        alias_row: u32,
        alias_name: &str,
    ) {
        let mut tuples: Vec<Node> = Vec::new();
        fn collect<'t>(n: Node<'t>, depth: u32, out: &mut Vec<Node<'t>>) {
            if depth > 6 {
                return;
            }
            if n.kind() == "tuple_type" {
                out.push(n);
            }
            for i in 0..n.named_child_count() {
                if let Some(c) = n.named_child(i) {
                    collect(c, depth + 1, out);
                }
            }
        }
        collect(value, 0, &mut tuples);
        if tuples.is_empty() {
            return;
        }

        self.stack.push(Scope {
            row: alias_row,
            kind: "type_alias",
            name: alias_name.to_string(),
        });
        for tuple in tuples {
            for i in 0..tuple.named_child_count() {
                let Some(entry) = tuple.named_child(i) else {
                    continue;
                };
                if entry.kind() != "generic_type" {
                    continue;
                }
                let Some(type_args) = entry.child_by_field_name("type_arguments") else {
                    continue;
                };
                for j in 0..type_args.named_child_count() {
                    let Some(arg) = type_args.named_child(j) else {
                        continue;
                    };
                    if arg.kind() != "literal_type" {
                        continue;
                    }
                    let Some(str_node) = arg.named_child(0) else {
                        continue;
                    };
                    if str_node.kind() != "string" {
                        continue;
                    }
                    let name = util::object_key_name(self.text(str_node).trim());
                    if !util::ident_dollar().is_match(&name) {
                        continue;
                    }
                    let collapsed = collapse_ws(self.text(entry));
                    let (signature, _) = util::slice_utf16(collapsed.trim(), 120);
                    let extra = Extra {
                        signature: Some(signature),
                        qualified_name: Some(format!("{alias_name}::{name}")),
                        ..Extra::default()
                    };
                    self.create_node("method", &name, entry, extra);
                }
            }
        }
        self.stack.pop();
    }

    pub(super) fn is_ts_function_typed_property(&self, property_signature: Node) -> bool {
        let Some(type_anno) = property_signature.child_by_field_name("type") else {
            return false;
        };
        for i in 0..type_anno.named_child_count() {
            if let Some(inner) = type_anno.named_child(i) {
                if inner.kind() == "function_type" {
                    return true;
                }
            }
        }
        false
    }
}
