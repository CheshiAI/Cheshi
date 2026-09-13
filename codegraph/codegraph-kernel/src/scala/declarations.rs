//! declarations for the scala extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- extractMethod → extractFunction routing (:1737 / :1517) ----------

    pub(super) fn extract_method_or_function(&mut self, node: Node<'t>) {
        // No receiver hook, no methodsAreTopLevel: inside class-like → method,
        // else → function (the object/object_expression parent check never
        // matches scala node kinds).
        let is_method = self.inside_class_like();
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            // Unreachable for scala defs (name field required) — preserved:
            // walk the body with nothing pushed.
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_body(body);
            }
            return;
        }
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_static = self.is_static_of(node);
        let return_type = self.return_type_of(node);
        let row = self.create_node(
            if is_method { "method" } else { "function" },
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility: Some(visibility),
                is_async: Some(false),
                is_static: Some(is_static),
                return_type,
                ..Default::default()
            },
        );
        let Some(row) = row else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope {
            row,
            kind: if is_method { "method" } else { "function" },
            name,
        });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    // --- extractClass (:1679) — classes, objects, traits ------------------

    pub(super) fn extract_class(&mut self, node: Node<'t>, kind: &'static str) {
        let resolved_body = node.child_by_field_name("body"); // template_body
                                                              // No skipBodilessClass — bodiless mints (scala-complete).
        let name = self.extract_name(node);
        let docstring = preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            kind,
            &name,
            node,
            Extra {
                docstring,
                visibility: Some(visibility),
                ..Default::default()
            },
        );
        let Some(row) = row else { return };
        self.extract_inheritance(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind, name });
        // THE ASYMMETRY: bodiless classes walk the node ITSELF — header
        // children (class_parameters defaults, extends args) reach the
        // ladder; bodied classes walk only template_body children.
        let body = resolved_body.unwrap_or(node);
        for child in util::named_children(body) {
            self.visit(child);
        }
        self.stack.pop();
    }

    // --- extractEnum (:1914) ----------------------------------------------

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let body = match node.child_by_field_name("body") {
            Some(b) => b,
            None => return, // bodiless enum mints nothing
        };
        let name = self.extract_name(node);
        let docstring = preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "enum",
            &name,
            node,
            Extra {
                docstring,
                visibility: Some(visibility),
                ..Default::default()
            },
        );
        let Some(row) = row else { return };
        self.extract_inheritance(node, row);
        // No extractDecoratorsFor on the enum path (annotated enums emit no
        // decorates — shared-pipeline behavior).
        self.stack.push(Scope {
            row,
            kind: "enum",
            name,
        });
        // enumMemberTypes is EMPTY → every body child goes through visitNode
        // (enum_case_definitions hits the hook; defs become methods).
        for child in util::named_children(body) {
            self.visit(child);
        }
        self.stack.pop();
    }

    // --- extractTypeAlias (:2890, plain path :2967-2991) ------------------

    /// Returns skipChildren — always false on the scala plain path.
    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring(node, self.src);
        // isExported hook absent; visibility not read on this path. The
        // alias-value ref walk reads field 'value' — scala's field is 'type'
        // → no reference to the aliased type, ever.
        self.create_doc_node("type_alias", &name, node, docstring);
        false
    }
}
