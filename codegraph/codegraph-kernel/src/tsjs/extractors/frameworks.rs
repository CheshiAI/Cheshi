//! frameworks for the tsjs/extractors extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- reactComponentHoc / extractReactComponentNode (#841) --------------------

    /// Some(inner) when the initializer is a recognized component wrapper —
    /// inner is the inline render function, or None for `styled.x`/`memo(Ref)`.
    /// Outer None = not a component wrapper.
    pub(super) fn react_component_hoc(&self, value: Node<'t>) -> Option<Option<Node<'t>>> {
        if value.kind() != "call_expression" {
            return None;
        }
        let callee = value.child_by_field_name("function")?;
        let callee_text = self.text(callee);
        if util::styled_callee().is_match(callee_text) {
            return Some(None);
        }
        if !is_react_hoc(callee_text) {
            return None;
        }
        let mut inner: Option<Node> = None;
        if let Some(args) = value.child_by_field_name("arguments") {
            for i in 0..args.named_child_count() {
                if let Some(a) = args.named_child(i) {
                    if matches!(a.kind(), "arrow_function" | "function_expression") {
                        inner = Some(a);
                        break;
                    }
                }
            }
        }
        Some(inner)
    }

    pub(super) fn extract_react_component_node(
        &mut self,
        name: &str,
        declarator: Node<'t>,
        inner_fn: Option<Node<'t>>,
        extra: Extra,
    ) {
        let Some(row) = self.create_node("component", name, declarator, extra) else {
            return;
        };
        let Some(inner) = inner_fn else { return };
        self.stack.push(Scope {
            row,
            kind: "component",
            name: name.to_string(),
        });
        if let Some(body) = body_of(inner) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    /// extractRtkHookBindings — `export const { useGetXQuery } = api`.
    pub(super) fn extract_rtk_hook_bindings(&mut self, pattern: Node<'t>, is_exported: bool) {
        for i in 0..pattern.named_child_count() {
            let Some(binding) = pattern.named_child(i) else {
                continue;
            };
            if binding.kind() != "shorthand_property_identifier_pattern" {
                continue;
            }
            let name = self.text(binding).to_string();
            if !util::rtk_hook_name().is_match(&name) {
                continue;
            }
            self.create_node(
                "function",
                &name,
                binding,
                Extra {
                    is_exported: Some(is_exported),
                    signature: Some("= RTK Query generated hook".to_string()),
                    ..Extra::default()
                },
            );
        }
    }

    // --- object-literal / store helpers -------------------------------------------------

    pub(in crate::tsjs) fn extract_object_literal_functions(&mut self, obj: Node<'t>) {
        for i in 0..obj.named_child_count() {
            let Some(member) = obj.named_child(i) else {
                continue;
            };
            if member.kind() == "pair" {
                let key = member.child_by_field_name("key");
                let value = member.child_by_field_name("value");
                if let (Some(k), Some(v)) = (key, value) {
                    if matches!(v.kind(), "arrow_function" | "function_expression") {
                        let name = util::object_key_name(self.text(k));
                        self.extract_function(v, Some(name));
                    }
                }
            } else if member.kind() == "method_definition" {
                if let Some(k) = member.child_by_field_name("name") {
                    let name = util::object_key_name(self.text(k));
                    self.extract_function(member, Some(name));
                }
            }
        }
    }

    pub(super) fn find_initializer_returned_object(
        &self,
        call: Node<'t>,
        depth: u32,
    ) -> Option<Node<'t>> {
        if depth > 4 {
            return None;
        }
        let args = call.child_by_field_name("arguments")?;
        for i in 0..args.named_child_count() {
            let Some(arg) = args.named_child(i) else {
                continue;
            };
            if matches!(arg.kind(), "arrow_function" | "function_expression") {
                if let Some(obj) = self.function_returned_object(arg) {
                    return Some(obj);
                }
            } else if arg.kind() == "call_expression" {
                if let Some(obj) = self.find_initializer_returned_object(arg, depth + 1) {
                    return Some(obj);
                }
            }
        }
        None
    }

    pub(super) fn function_returned_object(&self, fn_node: Node<'t>) -> Option<Node<'t>> {
        fn as_object(n: Node) -> Option<Node> {
            match n.kind() {
                "object" | "object_expression" => Some(n),
                "parenthesized_expression" => {
                    for child in util::named_children(n) {
                        if let Some(inner) = as_object(child) {
                            return Some(inner);
                        }
                    }
                    None
                }
                _ => None,
            }
        }
        let body = fn_node.child_by_field_name("body")?;
        if let Some(direct) = as_object(body) {
            return Some(direct);
        }
        if body.kind() == "statement_block" {
            for stmt in util::named_children(body) {
                if stmt.kind() != "return_statement" {
                    continue;
                }
                for child in util::named_children(stmt) {
                    if let Some(obj) = as_object(child) {
                        return Some(obj);
                    }
                }
            }
        }
        None
    }

    pub(in crate::tsjs) fn object_has_inline_functions(&self, obj: Node) -> bool {
        for i in 0..obj.named_child_count() {
            let Some(member) = obj.named_child(i) else {
                continue;
            };
            if member.kind() == "method_definition" {
                return true;
            }
            if member.kind() == "pair" {
                if let Some(v) = member.child_by_field_name("value") {
                    if matches!(v.kind(), "arrow_function" | "function_expression") {
                        return true;
                    }
                }
            }
        }
        false
    }

    pub(super) fn find_rtk_endpoints_object(&self, call: Node<'t>) -> Option<Node<'t>> {
        let callee = call.child_by_field_name("function")?;
        let callee_name = match callee.kind() {
            "identifier" => self.text(callee),
            "member_expression" => {
                let prop = callee.child_by_field_name("property").unwrap_or(callee);
                self.text(prop)
            }
            _ => "",
        };
        if callee_name != "createApi" && callee_name != "injectEndpoints" {
            return None;
        }
        let args = call.child_by_field_name("arguments")?;
        for i in 0..args.named_child_count() {
            let Some(arg) = args.named_child(i) else {
                continue;
            };
            if !matches!(arg.kind(), "object" | "object_expression") {
                continue;
            }
            for j in 0..arg.named_child_count() {
                let Some(member) = arg.named_child(j) else {
                    continue;
                };
                if member.kind() == "pair" {
                    let Some(key) = member.child_by_field_name("key") else {
                        continue;
                    };
                    if self.text(key) != "endpoints" {
                        continue;
                    }
                    if let Some(value) = member.child_by_field_name("value") {
                        if matches!(value.kind(), "arrow_function" | "function_expression") {
                            return self.function_returned_object(value);
                        }
                    }
                } else if member.kind() == "method_definition" {
                    let Some(key) = member.child_by_field_name("name") else {
                        continue;
                    };
                    if self.text(key) != "endpoints" {
                        continue;
                    }
                    return self.function_returned_object(member);
                }
            }
        }
        None
    }

    pub(super) fn extract_rtk_endpoints(&mut self, obj: Node<'t>) {
        for i in 0..obj.named_child_count() {
            let Some(member) = obj.named_child(i) else {
                continue;
            };
            if member.kind() != "pair" {
                continue;
            }
            let key = member.child_by_field_name("key");
            let value = member.child_by_field_name("value");
            let (Some(key), Some(value)) = (key, value) else {
                continue;
            };
            if value.kind() != "call_expression" {
                continue;
            }
            let Some(callee) = value.child_by_field_name("function") else {
                continue;
            };
            if callee.kind() != "member_expression" {
                continue;
            }
            let method = self.text(callee.child_by_field_name("property").unwrap_or(callee));
            if method != "query" && method != "mutation" && method != "infiniteQuery" {
                continue;
            }
            let key_name = util::object_key_name(self.text(key));
            if let Some(handler) = self.rtk_endpoint_handler(value) {
                self.extract_function(handler, Some(key_name));
            } else {
                // Config-only endpoint: bare node spanning the builder call.
                let (sig, _) = util::slice_utf16(self.text(value), 80);
                let row = self.create_node(
                    "function",
                    &key_name,
                    value,
                    Extra {
                        signature: Some(sig),
                        ..Extra::default()
                    },
                );
                if let Some(row) = row {
                    self.stack.push(Scope {
                        row,
                        kind: "function",
                        name: key_name,
                    });
                    self.visit_function_body(value);
                    self.stack.pop();
                }
            }
        }
    }

    pub(super) fn rtk_endpoint_handler(&self, call: Node<'t>) -> Option<Node<'t>> {
        let args = call.child_by_field_name("arguments")?;
        for i in 0..args.named_child_count() {
            let Some(arg) = args.named_child(i) else {
                continue;
            };
            if !matches!(arg.kind(), "object" | "object_expression") {
                continue;
            }
            let mut query_fn: Option<Node> = None;
            let mut query: Option<Node> = None;
            let mut first_fn: Option<Node> = None;
            for j in 0..arg.named_child_count() {
                let Some(member) = arg.named_child(j) else {
                    continue;
                };
                let mut fn_node: Option<Node> = None;
                let mut key_name = "";
                if member.kind() == "pair" {
                    if let Some(v) = member.child_by_field_name("value") {
                        if matches!(v.kind(), "arrow_function" | "function_expression") {
                            fn_node = Some(v);
                            if let Some(k) = member.child_by_field_name("key") {
                                key_name = self.text(k);
                            }
                        }
                    }
                } else if member.kind() == "method_definition" {
                    fn_node = Some(member);
                    if let Some(k) = member.child_by_field_name("name") {
                        key_name = self.text(k);
                    }
                }
                let Some(f) = fn_node else { continue };
                if key_name == "queryFn" {
                    query_fn = Some(f);
                } else if key_name == "query" {
                    query = Some(f);
                }
                if first_fn.is_none() {
                    first_fn = Some(f);
                }
            }
            if let Some(f) = query_fn.or(query).or(first_fn) {
                return Some(f);
            }
        }
        None
    }

    pub(in crate::tsjs) fn looks_like_vue_store_file(&mut self) -> bool {
        if let Some(v) = self.vue_store_file {
            return v;
        }
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for m in util::vue_store_signal().find_iter(self.src) {
            seen.insert(m.as_str());
            if seen.len() >= 2 {
                break;
            }
        }
        let v = seen.len() >= 2;
        self.vue_store_file = Some(v);
        v
    }

    pub(super) fn find_vue_store_collection_objects(&self, call: Node<'t>) -> Vec<Node<'t>> {
        let callee = call
            .child_by_field_name("function")
            .or_else(|| call.child_by_field_name("constructor"));
        let Some(callee) = callee else { return vec![] };
        let callee_name = match callee.kind() {
            "identifier" => self.text(callee),
            "member_expression" => {
                self.text(callee.child_by_field_name("property").unwrap_or(callee))
            }
            _ => "",
        };
        if !matches!(callee_name, "defineStore" | "createStore" | "Store") {
            return vec![];
        }
        let Some(args) = call.child_by_field_name("arguments") else {
            return vec![];
        };
        let mut objects = Vec::new();
        for i in 0..args.named_child_count() {
            let Some(arg) = args.named_child(i) else {
                continue;
            };
            if !matches!(arg.kind(), "object" | "object_expression") {
                continue;
            }
            for j in 0..arg.named_child_count() {
                let Some(member) = arg.named_child(j) else {
                    continue;
                };
                if member.kind() != "pair" {
                    continue;
                }
                let Some(key) = member.child_by_field_name("key") else {
                    continue;
                };
                if !is_vue_collection_name(self.text(key)) {
                    continue;
                }
                if let Some(value) = member.child_by_field_name("value") {
                    if matches!(value.kind(), "object" | "object_expression") {
                        objects.push(value);
                    }
                }
            }
        }
        objects
    }

    pub(in crate::tsjs) fn extract_store_collection_methods(&mut self, config: Node<'t>) {
        for i in 0..config.named_child_count() {
            let Some(member) = config.named_child(i) else {
                continue;
            };
            if member.kind() != "pair" {
                continue;
            }
            let Some(key) = member.child_by_field_name("key") else {
                continue;
            };
            if !is_vue_collection_name(self.text(key)) {
                continue;
            }
            if let Some(value) = member.child_by_field_name("value") {
                if matches!(value.kind(), "object" | "object_expression") {
                    self.extract_object_literal_functions(value);
                }
            }
        }
    }

    pub(super) fn find_pinia_setup_fn(&self, call: Node<'t>) -> Option<Node<'t>> {
        let callee = call.child_by_field_name("function")?;
        if callee.kind() != "identifier" || self.text(callee) != "defineStore" {
            return None;
        }
        let args = call.child_by_field_name("arguments")?;
        for i in 0..args.named_child_count() {
            let Some(arg) = args.named_child(i) else {
                continue;
            };
            if !matches!(arg.kind(), "arrow_function" | "function_expression") {
                continue;
            }
            if let Some(body) = arg.child_by_field_name("body") {
                if body.kind() == "statement_block" {
                    return Some(arg);
                }
            }
        }
        None
    }

    pub(super) fn extract_pinia_setup_body(&mut self, setup: Node<'t>) {
        let Some(body) = setup.child_by_field_name("body") else {
            return;
        };
        if body.kind() != "statement_block" {
            return;
        }
        for i in 0..body.named_child_count() {
            let Some(stmt) = body.named_child(i) else {
                continue;
            };
            if stmt.kind() == "function_declaration" {
                self.extract_function(stmt, None);
            } else if is_variable_type(stmt.kind()) {
                for j in 0..stmt.named_child_count() {
                    let Some(decl) = stmt.named_child(j) else {
                        continue;
                    };
                    if decl.kind() != "variable_declarator" {
                        continue;
                    }
                    if let Some(v) = decl.child_by_field_name("value") {
                        if matches!(v.kind(), "arrow_function" | "function_expression") {
                            self.extract_function(v, None);
                        }
                    }
                }
            }
        }
    }
}
