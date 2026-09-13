//! references for the kotlin extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        // Comment-gluing: the header's extent (and thus the signature) can
        // include trailing comment lines — the trimmed FULL text is the
        // signature; the ref stays at the header start.
        let import_text = self.text(node).trim().to_string();
        let identifier = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "identifier");
        let Some(identifier) = identifier else { return };
        let module_name = self.text(identifier).to_string();
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
        self.push_ref_at(
            parent,
            &module_name.clone(),
            edge_kind_index("imports").unwrap(),
            node,
        );
    }

    /// extractCall — the kotlin paths: navigation member branch (+ the #750
    /// re-encode) and the raw-text else (paren-then-lambda / glued-invoke
    /// garbage preserved).
    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let func = util::child_by_fields(node, &["function"], 0);
        let Some(func) = func else { return };
        let mut callee_name = String::new();

        if func.kind() == "navigation_expression" {
            let property =
                util::child_by_fields(func, &["property", "field"], 1).and_then(|candidate| {
                    if candidate.kind() == "navigation_suffix" {
                        util::first_named_child_kind(candidate, "simple_identifier")
                            .or(Some(candidate))
                    } else {
                        Some(candidate)
                    }
                });
            if let Some(property) = property {
                let method_name = self.text(property);
                let receiver = util::child_by_fields(func, &["object", "operand", "argument"], 0);
                if let Some(r) = receiver {
                    if is_literal_receiver(r.kind()) {
                        return; // `"literal".uppercase()` / `5.toString()`
                    }
                }
                let recv_ident = receiver.filter(|r| {
                    matches!(
                        r.kind(),
                        "identifier" | "simple_identifier" | "field_identifier"
                    )
                });
                if let Some(r) = recv_ident {
                    let receiver_name = self.text(r);
                    if matches!(receiver_name, "self" | "this" | "cls" | "super") {
                        callee_name = method_name.to_string();
                    } else {
                        callee_name = format!("{receiver_name}.{method_name}");
                    }
                } else if receiver
                    .map(|r| r.kind() == "call_expression")
                    .unwrap_or(false)
                {
                    // #750 kotlin re-encode: innerNav = receiver.namedChild(0)
                    // (NOT a function field), ws-stripped, /^[A-Z]/ gate.
                    let inner = receiver.unwrap().named_child(0);
                    let inner_callee = inner.map(|n| strip_js_ws(self.text(n))).unwrap_or_default();
                    let reencode = inner_callee
                        .as_bytes()
                        .first()
                        .map(|b| b.is_ascii_uppercase())
                        .unwrap_or(false);
                    callee_name = if reencode {
                        format!("{inner_callee}().{method_name}")
                    } else {
                        method_name.to_string()
                    };
                } else {
                    // this_expression / super_expression / 2-hop nav /
                    // postfix `!!` / parenthesized → bare method name.
                    callee_name = method_name.to_string();
                }
            }
        } else {
            // Raw func text: bare `helper`, constructor `WidgetK` (NO
            // instantiates ever), backticked names verbatim, the
            // paren-then-lambda `trailing()` and glued-invoke chains
            // byte-for-byte.
            callee_name = self.text(func).to_string();
        }

        util::emit_state_call_ref(&mut self.state, caller, &callee_name, node);
    }

    /// extractStaticMemberRef — navigation_expression value reads, body
    /// walker only (assignment WRITES parse as directly_assignable_expression
    /// — not a member-access kind — and emit nothing).
    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "navigation_expression" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        if util::is_call_callee_in(node, &["call_expression"], &["function", "method"]) {
            return;
        }
        let recv = util::child_by_fields(node, &["object", "expression", "scope"], 0);
        let Some(recv) = recv else { return };
        if let Some(text) = util::capitalized_identifier_text(recv, self.src) {
            self.push_ref_at(owner, text, edge_kind_index("references").unwrap(), recv);
        }
    }

    /// extractInheritance — delegation_specifier: user_type ?? its
    /// constructor_invocation's user_type → FIRST type_identifier → ONE
    /// `extends` ref at the typeId (interfaces ride extends too; qualified
    /// supertypes take the FIRST segment — `com`; `by`-delegation emits
    /// NOTHING).
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else {
                continue;
            };
            if child.kind() != "delegation_specifier" {
                continue;
            }
            let user_type = (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| c.kind() == "user_type");
            let ctor_inv = (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| c.kind() == "constructor_invocation");
            let target = user_type.or(ctor_inv);
            let Some(target) = target else { continue };
            let type_id: Node = if target.kind() == "user_type" {
                (0..target.named_child_count())
                    .filter_map(|j| target.named_child(j))
                    .find(|c| c.kind() == "type_identifier")
                    .unwrap_or(target)
            } else {
                // constructor_invocation → its user_type → first type_identifier
                let ut = (0..target.named_child_count())
                    .filter_map(|j| target.named_child(j))
                    .find(|c| c.kind() == "user_type");
                match ut {
                    Some(ut) => (0..ut.named_child_count())
                        .filter_map(|j| ut.named_child(j))
                        .find(|c| c.kind() == "type_identifier")
                        .unwrap_or(ut),
                    None => target,
                }
            };
            let name = self.text(type_id).to_string();
            self.push_ref_at(class_row, &name, extends_kind, type_id);
        }
    }

    /// extractDecoratorsFor — kotlin annotations inside `modifiers`:
    /// `@Marker` (user_type child) → decorates ref; `@Anno(args)`
    /// (constructor_invocation) → NOTHING. Runs for functions/methods/classes
    /// only (hook properties never call it).
    pub(super) fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for node in util::decorator_nodes(decl) {
            self.consider_decorator(node, decorated_row);
        }
    }

    pub(super) fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        let Some(name) = util::decorator_name(n, self.src) else {
            return;
        };
        util::emit_state_decorator_ref(&mut self.state, decorated_row, &name, n);
    }
}
