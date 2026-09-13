//! declarations for the rustlang extractor.

use super::*;

impl<'t> Walker<'t> {
    /// extractInterface — kind `trait` (interfaceKind), inheritance from
    /// trait_bounds, body children visited with the trait pushed.
    pub(super) fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default() // no visibility/isExported on the interface path
        };
        let Some(row) = self.create_node("trait", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);

        let body = node.child_by_field_name("body").unwrap_or(node);
        self.with_scope(row, "trait", name, |walker| {
            for child in util::named_children(body) {
                walker.visit_node(child);
            }
        });
    }

    /// extractStruct — body field REQUIRED (unit structs mint no node; tuple
    /// structs' ordered_field_declaration_list is a body).
    pub(super) fn extract_struct(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("struct", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);

        self.with_scope(row, "struct", name, |walker| {
            for child in util::named_children(body) {
                walker.visit_node(child);
            }
        });
    }

    /// extractEnum — body required; enum_variant children → enum_member nodes
    /// (name field only, payloads never walked); other children re-dispatched.
    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);

        self.with_scope(row, "enum", name, |walker| {
            for child in util::named_children(body) {
                if child.kind() == "enum_variant" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let vname = walker.text(name_node).to_string();
                        walker.create_node("enum_member", &vname, child, Extra::default());
                    }
                } else {
                    walker.visit_node(child);
                }
            }
        });
    }

    /// extractTypeAlias — plain `type_alias` node. QUIRK: the alias-value ref
    /// walk reads a `value` field; rust type_item's field is `type` → no ref
    /// to the aliased type. Returns children-visited (false) like the TS.
    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
        };
        self.create_node("type_alias", &name, node, extra);
    }

    /// extractVariable's generic fallback: kind is ALWAYS `variable` (no
    /// isConst hook), every direct `identifier` child mints a node positioned
    /// at the CHILD, docstring shared, isExported present-false, no signature,
    /// and the initializer value is never body-walked.
    pub(super) fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        for child in util::named_children(node).filter(|child| child.kind() == "identifier") {
            let name = self.text(child).to_string();
            if !name.is_empty() {
                self.create_node(
                    "variable",
                    &name,
                    child,
                    Extra {
                        docstring: docstring.clone(),
                        is_exported: Some(false),
                        ..Extra::default()
                    },
                );
            }
        }
    }
}
