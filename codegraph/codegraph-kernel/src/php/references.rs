//! references for the php extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let import_text = self.text(node).trim().to_string();
        let imports_kind = edge_kind_index("imports").unwrap();

        if matches!(
            kind,
            "include_expression"
                | "include_once_expression"
                | "require_expression"
                | "require_once_expression"
        ) {
            // phpStaticIncludePath: static string literals only; dynamic
            // forms (`__DIR__ . '/x'`, interpolation) emit NOTHING.
            let mut arg = node.named_child(0);
            if let Some(a) = arg {
                if a.kind() == "parenthesized_expression" {
                    arg = a.named_child(0);
                }
            }
            let Some(arg) = arg else { return };
            if !matches!(arg.kind(), "string" | "encapsed_string") {
                return;
            }
            let mut content: Option<Node> = None;
            for i in 0..arg.named_child_count() {
                let Some(c) = arg.named_child(i) else {
                    continue;
                };
                if c.kind() != "string_content" {
                    return; // interpolation/escape → not a static path
                }
                if content.is_none() {
                    content = Some(c);
                }
            }
            let Some(content) = content else { return };
            let module_name = self.text(content).to_string();
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
            self.push_ref_at(parent, &module_name.clone(), imports_kind, node);
            return;
        }

        // namespace_use_declaration.
        let ns_prefix = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "namespace_name");
        let use_group = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "namespace_use_group");
        if let (Some(ns_prefix), Some(use_group)) = (ns_prefix, use_group) {
            // Grouped `use A\{B, C as D, Sub\E}` — hook declines, the inline
            // branch emits per-member nodes named `A\B` (first `name` child =
            // the SOURCE name; a nested `Sub\E` clause has a qualified_name,
            // no direct `name` → SKIPPED, grammar-bump delta #2). All nodes
            // and refs sit at the whole declaration's position.
            let prefix = self.text(ns_prefix).to_string();
            let clauses: Vec<Node> = (0..use_group.named_child_count())
                .filter_map(|i| use_group.named_child(i))
                .filter(|c| {
                    matches!(
                        c.kind(),
                        "namespace_use_group_clause" | "namespace_use_clause"
                    )
                })
                .collect();
            for clause in clauses {
                let ns_name = (0..clause.named_child_count())
                    .filter_map(|i| clause.named_child(i))
                    .find(|c| c.kind() == "namespace_name");
                let name = match ns_name {
                    Some(nn) => (0..nn.named_child_count())
                        .filter_map(|i| nn.named_child(i))
                        .find(|c| c.kind() == "name"),
                    None => (0..clause.named_child_count())
                        .filter_map(|i| clause.named_child(i))
                        .find(|c| c.kind() == "name"),
                };
                if let Some(name) = name {
                    let full = format!("{prefix}\\{}", self.text(name));
                    self.create_node(
                        "import",
                        &full,
                        node,
                        Extra {
                            signature: Some(import_text.clone()),
                            ..Extra::default()
                        },
                    );
                    let parent = self.top_row();
                    self.push_php_use_ref(&full, parent, node);
                }
            }
            return;
        }

        // Single use (incl. `use function`/`use const`/aliased): the hook's
        // qualified_name-else-name read; alias never included.
        let use_clause = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "namespace_use_clause");
        let Some(use_clause) = use_clause else { return };
        let target = (0..use_clause.named_child_count())
            .filter_map(|i| use_clause.named_child(i))
            .find(|c| c.kind() == "qualified_name")
            .or_else(|| {
                (0..use_clause.named_child_count())
                    .filter_map(|i| use_clause.named_child(i))
                    .find(|c| c.kind() == "name")
            });
        let Some(target) = target else { return }; // hook null → nothing
        let module_name = self.text(target).to_string();
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
        self.push_ref_at(parent, &module_name.clone(), imports_kind, node);
        // emitPhpUseRefs → the `Foo\Bar::Baz` ref (bare single-segment `use
        // Countable;` has no `\` → no `::` ref).
        self.push_php_use_ref(&module_name, parent, node);
    }

    // --- calls ---------------------------------------------------------------------

    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let mut callee_name = String::new();

        let name_field = node.child_by_field_name("name");
        let object_field = node
            .child_by_field_name("object")
            .or_else(|| node.child_by_field_name("scope"));

        if let (Some(name_field), Some(object_field)) = (name_field, object_field) {
            // member_call_expression / scoped_call_expression.
            let method_name = self.text(name_field);

            // Fluent static-factory `Cls::factory($x)->method()` — encode
            // `Cls::factory().method` (inner args dropped) and return; the
            // inner scoped call is also visited by recursion (`Cls.factory`).
            if !method_name.is_empty() && object_field.kind() == "scoped_call_expression" {
                let inner_scope = object_field.child_by_field_name("scope");
                let inner_name = object_field.child_by_field_name("name");
                let callee = match (inner_scope, inner_name) {
                    (Some(s), Some(n)) => {
                        format!("{}::{}().{method_name}", self.text(s), self.text(n))
                    }
                    _ => method_name.to_string(),
                };
                if !callee.is_empty() {
                    self.push_ref_at(caller, &callee, edge_kind_index("calls").unwrap(), node);
                }
                return;
            }

            // receiverName = raw receiver text with ONE leading `$` stripped:
            // `$this->prop->m()` → `this->prop.m` (#1251 encoding — the whole
            // resolution machinery is TS-side); chains keep args
            // (`this->factory($cfg).m`); literals are NOT suppressed
            // (`"chain".upper`); scoped calls are DOT-joined (`UserModel.query`).
            let receiver_raw = self.text(object_field);
            let receiver = receiver_raw.strip_prefix('$').unwrap_or(receiver_raw);
            if !method_name.is_empty() {
                if matches!(
                    receiver,
                    "self" | "this" | "cls" | "super" | "parent" | "static"
                ) {
                    callee_name = method_name.to_string();
                } else {
                    callee_name = format!("{receiver}.{method_name}");
                }
            }
        } else {
            // function_call_expression: raw func text — bare `helper`,
            // qualified `\App\Helpers\format_id` verbatim, `$fn` for
            // variable callees, FCC `f(...)` → `f`.
            let func = util::child_by_fields(node, &["function"], 0);
            if let Some(func) = func {
                callee_name = self.text(func).to_string();
            }
        }

        util::emit_state_call_ref(&mut self.state, caller, &callee_name, node);
    }

    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        // php has no constructor/type/name FIELDS → namedChild(0). Backslashes
        // are NOT split by the suffix logic → `new \App\Models\User()` keeps
        // the full qualified text; `new $cls()` keeps the `$`; an
        // anonymous_class yields its whole source text through the shared
        // normalization (garbage, deterministic — preserve).
        let ctor = php_constructor_node(node);
        let Some(ctor) = ctor else { return };
        let class_name = util::strip_generic_and_qualifier(self.text(ctor));
        if class_name.is_empty() {
            return;
        }
        let from = self.top_row();
        util::emit_state_ref_at(
            &mut self.state,
            from,
            &class_name,
            edge_kind_index("instantiates").unwrap(),
            node,
        );
    }

    /// extractStaticMemberRef — php's class_constant_access_expression +
    /// scoped_property_access_expression (member_access_expression is
    /// evaluated but its variable_name receiver never passes).
    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if !matches!(
            node.kind(),
            "class_constant_access_expression"
                | "scoped_property_access_expression"
                | "member_access_expression"
        ) {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        if util::is_call_callee_in(
            node,
            &[
                "function_call_expression",
                "member_call_expression",
                "scoped_call_expression",
            ],
            &["function", "method"],
        ) {
            return;
        }
        let recv = util::child_by_fields(node, &["object", "expression", "scope"], 0);
        let Some(recv) = recv else { return };
        if let Some(text) = util::capitalized_identifier_text(recv, self.src) {
            self.push_ref_at(owner, text, edge_kind_index("references").unwrap(), recv);
        }
    }

    /// extractInheritance — base_clause takes ONLY the first base (interface
    /// multi-extends drops the rest); class_interface_clause takes ALL
    /// children unfiltered (full text, incl. leading `\`).
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        let implements_kind = edge_kind_index("implements").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            if child.kind() == "base_clause" {
                if let Some(target) = child.named_child(0) {
                    let name = self.text(target).to_string();
                    self.push_ref_at(class_row, &name, extends_kind, target);
                }
            } else if child.kind() == "class_interface_clause" {
                for j in 0..child.named_child_count() {
                    let Some(iface) = child.named_child(j) else {
                        continue;
                    };
                    let name = self.text(iface).to_string();
                    self.push_ref_at(class_row, &name, implements_kind, iface);
                }
            }
        }
    }

    // --- php type refs (extractPhpTypeRefs, 6022) ----------------------------------

    pub(super) fn extract_php_type_refs(&mut self, node: Node<'t>, from_row: u32) {
        let params = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "formal_parameters");
        if let Some(params) = params {
            for i in 0..params.named_child_count() {
                let Some(p) = params.named_child(i) else {
                    continue;
                };
                for j in 0..p.named_child_count() {
                    let Some(c) = p.named_child(j) else { continue };
                    if is_php_type_node(c.kind()) {
                        self.walk_php_type_position(c, from_row);
                    }
                }
            }
        }
        for i in 0..node.named_child_count() {
            let Some(c) = node.named_child(i) else {
                continue;
            };
            if is_php_type_node(c.kind()) {
                self.walk_php_type_position(c, from_row);
            }
        }
    }
}
