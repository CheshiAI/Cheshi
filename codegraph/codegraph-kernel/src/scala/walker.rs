//! walker for the scala extractor.

use super::*;

impl<'t> Walker<'t> {
    pub(super) fn push_ref_at(&mut self, from_row: u32, name: &str, kind: &str, node: Node) {
        let kind_code = edge_kind_index(kind).unwrap();
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
        // flushFnRefCandidates' importedNames (tree-sitter.ts:661-675). Scala
        // import refs are named the FIRST path segment — always SIMPLE_NAME.
        if kind == "imports" {
            util::record_import_name(&mut self.imported_names, name);
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
        let row = util::emit_node_row(&mut self.state, kind, name, node, extra)?;
        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }

        // captureValueRefScope (:735-767).
        let parent_kind = self.stack.last().map(|scope| scope.kind);
        util::record_value_ref_target_if(&mut self.state, kind, name, parent_kind, row);
        if util::is_value_ref_scope_node(kind) {
            self.value_scopes.push(ValueScope {
                row,
                node,
                name: name.to_string(),
            });
        }

        Some(row)
    }

    pub(super) fn create_doc_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        docstring: Option<String>,
    ) -> Option<u32> {
        self.create_node(
            kind,
            name,
            node,
            Extra {
                docstring,
                ..Default::default()
            },
        )
    }

    // --- languages/scala.ts helper transcriptions -------------------------

    /// getValVarName (scala.ts:5-11).
    pub(super) fn val_var_name(&self, node: Node<'t>) -> Option<&'t str> {
        let pattern = node.child_by_field_name("pattern")?;
        if pattern.kind() == "identifier" {
            return Some(self.text(pattern));
        }
        if let Some(identifier) = util::first_named_child_kind(pattern, "identifier") {
            return Some(self.text(identifier));
        }
        None
    }

    /// extractVisibility (scala.ts:69-80) → wire byte (1 public default).
    pub(super) fn visibility_of(&self, node: Node<'t>) -> u8 {
        for c in util::named_children(node) {
            if c.kind() == "modifiers" || c.kind() == "access_modifier" {
                let t = self.text(c);
                if t.contains("private") {
                    return 2;
                }
                if t.contains("protected") {
                    return 3;
                }
            }
        }
        1
    }

    /// isStatic (scala.ts:123-129) — text scan, effectively always false.
    pub(super) fn is_static_of(&self, node: Node<'t>) -> bool {
        for c in util::named_children(node) {
            if c.kind() == "modifiers" && self.text(c).contains("static") {
                return true;
            }
        }
        false
    }

    /// getSignature (scala.ts:110-117) — first-match-wins fields: curried
    /// defs keep only the first list; a type_parameters node carrying field
    /// `parameters` wins over the value list.
    pub(super) fn signature_of(&self, node: Node<'t>) -> Option<String> {
        let params = node.child_by_field_name("parameters");
        let ret = node.child_by_field_name("return_type");
        if params.is_none() && ret.is_none() {
            return None;
        }
        let mut sig = params.map(|p| self.text(p).to_string()).unwrap_or_default();
        if let Some(r) = ret {
            sig.push_str(": ");
            sig.push_str(self.text(r));
        }
        if sig.is_empty() {
            None
        } else {
            Some(sig)
        }
    }

    /// extractScalaReturnType (scala.ts:56-67).
    pub(super) fn return_type_of(&self, node: Node<'t>) -> Option<String> {
        let rt = node.child_by_field_name("return_type")?;
        let raw = self.text(rt).trim();
        if raw.starts_with("this.") {
            return None;
        }
        let base = bracket_args_re().replace_all(raw, "");
        let base = ws_re().replace_all(&base, "");
        let last = base.split('.').next_back()?;
        if last.is_empty() || !simple_type_name_re().is_match(last) {
            return None;
        }
        Some(last.to_string())
    }

    /// scalaBaseTypeName (tree-sitter.ts:201-224).
    pub(super) fn scala_base_type_name(&self, node: Option<Node<'t>>) -> Option<String> {
        let node = node?;
        match node.kind() {
            "type_identifier" | "identifier" => Some(self.text(node).to_string()),
            "generic_type" => self.scala_base_type_name(node.named_child(0)),
            "stable_type_identifier" | "stable_identifier" => {
                let last = util::named_children(node)
                    .filter(|c| c.kind() == "type_identifier" || c.kind() == "identifier")
                    .last();
                last.map(|n| self.text(n).to_string())
            }
            _ => {
                let id = util::first_named_child_kind(node, "type_identifier");
                id.map(|n| self.text(n).to_string())
            }
        }
    }

    /// extractName (tree-sitter.ts:98-192) — scala-reachable branches: the
    /// `name` field's raw text (operator glyphs and backticks kept), else the
    /// first identifier-ish child, else `<anonymous>`.
    pub(super) fn extract_name(&self, node: Node<'t>) -> String {
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if let Some(identifier) = util::first_named_child_kind_any(
            node,
            &[
                "identifier",
                "type_identifier",
                "simple_identifier",
                "constant",
            ],
        ) {
            return self.text(identifier).to_string();
        }
        "<anonymous>".to_string()
    }

    // --- the main walk (visitNode, tree-sitter.ts:936-1303) ---------------

    pub(super) fn visit(&mut self, node: Node<'t>) {
        // The visitNode hook (scala.ts:131-198) runs FIRST.
        if self.hook(node) {
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

        // maybeCaptureFnRefs (:990).
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        match kind {
            // methodTypes (functionTypes is EMPTY — :994 never fires).
            "function_definition" | "function_declaration" => {
                self.extract_method_or_function(node);
                return; // skipChildren
            }
            "class_definition" | "object_definition" => {
                self.extract_class(node, "class");
                return;
            }
            "trait_definition" => {
                self.extract_class(node, "trait");
                return;
            }
            "enum_definition" => {
                self.extract_enum(node);
                return;
            }
            "type_definition" => {
                let skip = self.extract_type_alias(node);
                if skip {
                    return;
                }
                // plain path → false → children re-visited (nothing matches).
            }
            "import_declaration" => {
                self.extract_import(node);
                return; // skipChildren
            }
            "call_expression" => {
                self.extract_call(node);
                // no skipChildren — chains/args re-visited
            }
            "instance_expression" => {
                // INSTANTIATION_KINDS (:1255). findAnonymousClassBody looks
                // for class_body/declaration_list — scala's template_body is
                // neither → extractAnonymousClass never runs → children
                // recursed: anon-body defs LEAK to the enclosing scope.
                self.extract_instantiation(node);
            }
            _ => {}
        }

        for child in util::named_children(node) {
            self.visit(child);
        }
    }

    /// The visitNode hook (scala.ts:131-198). Returns true when consumed.
    pub(super) fn hook(&mut self, node: Node<'t>) -> bool {
        match node.kind() {
            "val_definition" | "var_definition" => {
                let is_val = node.kind() == "val_definition";
                let name = match self.val_var_name(node) {
                    Some(n) => n.to_string(),
                    None => return false,
                };
                // Enclosing-definition NODE-TYPE walk (scala.ts:146-156).
                let mut enclosing: Option<&'static str> = None;
                let mut p = node.parent();
                while let Some(parent) = p {
                    match parent.kind() {
                        "class_definition" => {
                            enclosing = Some("class_definition");
                            break;
                        }
                        "trait_definition" => {
                            enclosing = Some("trait_definition");
                            break;
                        }
                        "enum_definition" => {
                            enclosing = Some("enum_definition");
                            break;
                        }
                        "given_definition" => {
                            enclosing = Some("given_definition");
                            break;
                        }
                        "object_definition" => {
                            enclosing = Some("object_definition");
                            break;
                        }
                        _ => p = parent.parent(),
                    }
                }
                let is_instance_field = matches!(
                    enclosing,
                    Some("class_definition")
                        | Some("trait_definition")
                        | Some("enum_definition")
                        | Some("given_definition")
                );
                let kind: &'static str = if is_instance_field {
                    "field"
                } else if is_val {
                    "constant"
                } else {
                    "variable"
                };
                let type_node = node.child_by_field_name("type");
                let signature = type_node.map(|t| {
                    format!(
                        "{} {}: {}",
                        if is_val { "val" } else { "var" },
                        name,
                        self.text(t)
                    )
                });
                let visibility = self.visibility_of(node);
                let created = self.create_node(
                    kind,
                    &name,
                    node,
                    Extra {
                        signature,
                        visibility: Some(visibility),
                        ..Default::default()
                    },
                );
                if let (Some(row), Some(t)) = (created, type_node) {
                    self.emit_scala_type_refs(t, row);
                }
                true
            }
            "enum_case_definitions" => {
                for case in util::named_children(node)
                    .filter(|case| matches!(case.kind(), "simple_enum_case" | "full_enum_case"))
                {
                    let Some(name_node) = case.child_by_field_name("name") else {
                        continue;
                    };
                    let name = self.text(name_node).to_string();
                    // ctx.createNode('enum_member', name, child) — no extras.
                    self.create_node("enum_member", &name, case, Extra::default());
                }
                true
            }
            "extension_definition" => {
                // childForFieldName('body') is FIRST-MATCH-WINS over the full
                // (named + anonymous) child list: paren/indent form → the
                // first function_definition (its children visited — no node
                // minted, later defs invisible); braced form → the `{` TOKEN
                // (namedChildCount 0 — whole extension invisible).
                if let Some(body) = node.child_by_field_name("body") {
                    for child in util::named_children(body) {
                        self.visit(child);
                    }
                }
                true
            }
            _ => false,
        }
    }

    // --- visitFunctionBody (:5129-5286) — scala rows ----------------------

    pub(super) fn visit_body(&mut self, node: Node<'t>) {
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        if kind == "call_expression" {
            self.extract_call(node);
            // falls through to recursion
        } else if kind == "instance_expression" {
            // instantiates + recursion (findAnonymousClassBody null): anon
            // template_body defs are NOT dispatched here (functionTypes
            // empty; methodTypes not checked in this walker) — their calls
            // attribute to the enclosing method.
            self.extract_instantiation(node);
        }

        self.extract_static_member_ref(node);

        // Nested named defs mint NOTHING (:5245 checks functionTypes — EMPTY;
        // the inverse of kotlin). Body-local classes/objects/traits/enums DO
        // extract fully.
        match kind {
            "class_definition" | "object_definition" => {
                self.extract_class(node, "class");
                return;
            }
            "trait_definition" => {
                self.extract_class(node, "trait");
                return;
            }
            "enum_definition" => {
                self.extract_enum(node);
                return;
            }
            _ => {}
        }

        for child in util::named_children(node) {
            self.visit_body(child);
        }
    }
}
