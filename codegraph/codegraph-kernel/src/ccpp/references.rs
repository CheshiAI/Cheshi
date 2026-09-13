//! references for the ccpp/mod extractor.

use super::*;

impl<'t> Walker<'t> {
    /// extractImport via the c/cpp extractImport hook: `#include <sys.h>` /
    /// `#include "local.h"`. A hook miss (`#include MACRO`) extracts nothing.
    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let module_name: Option<String> =
            if let Some(sys) = self.find_child_by_kind(node, "system_lib_string") {
                let t = self.text(sys);
                let t = t.strip_prefix('<').unwrap_or(t);
                let t = t.strip_suffix('>').unwrap_or(t);
                Some(t.to_string())
            } else if let Some(lit) = self.find_child_by_kind(node, "string_literal") {
                self.find_child_by_kind(lit, "string_content")
                    .map(|sc| self.text(sc).to_string())
            } else {
                None
            };
        let Some(module_name) = module_name else {
            return;
        };
        self.create_node(
            "import",
            &module_name,
            node,
            Extra {
                signature: Some(import_text),
                ..Extra::default()
            },
        );
        if !module_name.is_empty() {
            let parent = self.top_row();
            self.push_ref_at(
                parent,
                &module_name,
                edge_kind_index("imports").unwrap(),
                node,
            );
        }
    }

    // --- calls / instantiation ----------------------------------------------

    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        let func = util::child_by_fields(node, &["function"], 0);
        let calls_kind = edge_kind_index("calls").unwrap();

        // C++ explicit operator call `a.operator+(b)` (#1247): the
        // operator_name hides in an ERROR child. (has_error() defers such
        // files to wasm, so this scan is a faithful no-op today.)
        if self.variant == Variant::Cpp {
            if let Some(func) = func {
                let mut operator_name = String::new();
                'err: for child in named_children(node) {
                    if child.kind() != "ERROR" {
                        continue;
                    }
                    for op in named_children(child) {
                        if op.kind() == "operator_name" {
                            operator_name = self.text(op).to_string();
                            break 'err;
                        }
                    }
                }
                if !operator_name.is_empty() {
                    let sym = operator_name["operator".len()..].trim().to_string();
                    if symbolic_op_re().is_match(&sym) {
                        let compact: String = sym.chars().filter(|c| !c.is_whitespace()).collect();
                        operator_name = format!("operator{compact}");
                    }
                    let receiver = arrow_dot_no_ws(self.text(func));
                    if receiver != "this" && !operator_receiver_re().is_match(&receiver) {
                        return;
                    }
                    let callee = if receiver == "this" {
                        operator_name
                    } else {
                        format!("{receiver}.{operator_name}")
                    };
                    self.push_ref_at(caller_row, &callee, calls_kind, node);
                    return;
                }
            }
        }

        let mut callee_name = String::new();
        if let Some(func) = func {
            if func.kind() == "field_expression" {
                // `obj.method()` / `ptr->method()` — the `field` field.
                let property = util::child_by_fields(func, &["property", "field"], 1);
                if let Some(property) = property {
                    let method_name = self.text(property);
                    let receiver =
                        util::child_by_fields(func, &["object", "operand", "argument"], 0);
                    if let Some(r) = receiver {
                        if is_literal_receiver(r.kind()) {
                            return; // #1230: literal receivers emit nothing
                        }
                    }
                    match receiver.map(|r| r.kind()) {
                        Some("identifier")
                        | Some("simple_identifier")
                        | Some("field_identifier") => {
                            let receiver_name = self.text(receiver.unwrap());
                            callee_name =
                                util::compose_member_callee(Some(receiver_name), method_name);
                        }
                        Some("call_expression") => {
                            // Call-result receiver (#645/#608): re-encode as
                            // `<innerCallee>().<method>` — C/C++ re-encode any inner.
                            let inner_fn = receiver.unwrap().child_by_field_name("function");
                            let inner_callee = inner_fn
                                .map(|f| arrow_dot_no_ws(self.text(f)))
                                .unwrap_or_default();
                            if !inner_callee.is_empty() {
                                callee_name = format!("{inner_callee}().{method_name}");
                            } else {
                                callee_name = method_name.to_string();
                            }
                        }
                        _ => {
                            callee_name = method_name.to_string();
                        }
                    }
                }
            } else {
                // Bare / qualified / templated / parenthesized callee.
                callee_name = self.text(func).to_string();
            }
        }

        // `(*fp)(x)` → `fp`, and strip template arguments from callees.
        callee_name = normalize_cpp_callee_name(callee_name);

        // Local fn-pointer fan-out: a bare callee bound earlier from `&fn`
        // emits one calls ref PER recorded target (insertion order).
        if !callee_name.is_empty()
            && self.variant == Variant::Cpp
            && simple_ident_re().is_match(&callee_name)
        {
            let targets = self
                .local_fn_ptrs
                .get(&caller_row)
                .and_then(|locals| locals.get(&callee_name))
                .cloned();
            if let Some(targets) = targets {
                if !targets.is_empty() {
                    for target in &targets {
                        self.push_ref_at(caller_row, target, calls_kind, node);
                    }
                    return;
                }
            }
        }

        if !callee_name.is_empty() {
            self.push_ref_at(caller_row, &callee_name, calls_kind, node);
        }
    }

    /// extractInstantiation: `new Foo(...)` and stack constructions (both
    /// read the type from the `type` field; template args + qualifiers strip).
    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        let ctor = util::child_by_fields(node, &["constructor", "type", "name"], 0);
        let Some(ctor) = ctor else { return };

        let class_name = util::strip_generic_and_qualifier(self.text(ctor));
        if !class_name.is_empty() {
            self.push_ref_at(
                from,
                &class_name,
                edge_kind_index("instantiates").unwrap(),
                node,
            );
        }
    }

    /// extractStaticMemberRef — cpp only (c is not in STATIC_MEMBER_LANGS).
    /// In this grammar the firing shape is `field_expression` (listed in
    /// MEMBER_ACCESS_TYPES for Scala — same node kind here): a capitalized
    /// simple receiver's value read.
    pub(super) fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if self.variant != Variant::Cpp {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        if !matches!(node.kind(), "field_expression" | "qualified_identifier") {
            return;
        }
        // Skip `Type.method()` — the access is a call's callee, already linked.
        if let Some(parent) = node.parent() {
            if parent.kind() == "call_expression" {
                let callee = util::child_by_fields(parent, &["function", "method"], 0);
                if let Some(callee) = callee {
                    if callee.start_byte() == node.start_byte() {
                        return;
                    }
                }
            }
        }
        let recv = util::child_by_fields(node, &["object", "expression", "scope"], 0);
        let Some(recv) = recv else { return };
        if !matches!(
            recv.kind(),
            "identifier"
                | "type_identifier"
                | "simple_identifier"
                | "name"
                | "scoped_type_identifier"
        ) {
            return;
        }
        let text = self.text(recv);
        if capitalized_re().is_match(text) {
            let owner = self.top_row();
            let name = text.to_string();
            self.push_ref_at(owner, &name, edge_kind_index("references").unwrap(), recv);
        }
    }

    // --- inheritance ---------------------------------------------------------

    /// extractInheritance — the branches whose node kinds occur in the c/cpp
    /// grammars: base_class_clause (#1043), the field_declaration Go-embedding
    /// shape, and the field_declaration_list recursion that reaches it.
    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for child in named_children(node) {
            match child.kind() {
                "base_class_clause" => {
                    for t in named_children(child) {
                        if matches!(
                            t.kind(),
                            "type_identifier" | "qualified_identifier" | "template_type"
                        ) {
                            let name = strip_cpp_template_args(self.text(t));
                            self.push_ref_at(class_row, &name, extends_kind, t);
                        }
                    }
                }
                "field_declaration" => {
                    let has_field_identifier =
                        util::has_named_child_kind(child, "field_identifier");
                    if !has_field_identifier {
                        let type_id = util::first_named_child_kind(child, "type_identifier");
                        if let Some(type_id) = type_id {
                            let name = self.text(type_id).to_string();
                            self.push_ref_at(class_row, &name, extends_kind, type_id);
                        }
                    }
                }
                "field_declaration_list" | "class_heritage" => {
                    self.extract_inheritance(child, class_row);
                }
                _ => {}
            }
        }
    }
}
