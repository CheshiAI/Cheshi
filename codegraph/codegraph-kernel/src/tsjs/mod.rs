//! TypeScript / TSX / JavaScript / JSX extraction — a faithful Rust port of
//! `TreeSitterExtractor`'s TS/JS paths (src/extraction/tree-sitter.ts) plus
//! the typescript/javascript LanguageExtractor configs.
//!
//! Porting contract (R2 of the migration plan): behavior parity with the wasm
//! path, verified by `bun run kernel:parity` over real repos — including
//! bug-for-bug fidelity where the TS code has quirks. Every function notes the
//! TS function it mirrors; if you change one side, change the other or the
//! parity gate fails. Positions are emitted in UTF-16 code units (what
//! web-tree-sitter reports), see util::col16.

mod extractors;
mod fnref;
use crate::textutil as util;

use crate::buffers::{edge_kind_index, Arena, EmitOut, RefRow, Tables};
use crate::langs;
use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Typescript,
    Tsx,
    Javascript,
    Jsx,
}

impl Variant {
    pub fn from_language(language: &str) -> Option<Variant> {
        match language {
            "typescript" => Some(Variant::Typescript),
            "tsx" => Some(Variant::Tsx),
            "javascript" => Some(Variant::Javascript),
            "jsx" => Some(Variant::Jsx),
            _ => None,
        }
    }
    /// TS-family (typescript/tsx): type annotations, interfaces, enums,
    /// aliases, visibility, isStatic. The JS family lacks all of those hooks.
    fn is_ts(self) -> bool {
        matches!(self, Variant::Typescript | Variant::Tsx)
    }
    /// VALUE_REF_LANGS includes typescript/tsx/javascript but NOT jsx.
    fn value_refs(self) -> bool {
        !matches!(self, Variant::Jsx)
    }
}

/// typescriptExtractor.methodTypes / javascriptExtractor.methodTypes.
fn is_method_type(v: Variant, kind: &str) -> bool {
    kind == "method_definition"
        || (v.is_ts() && kind == "public_field_definition")
        || (!v.is_ts() && kind == "field_definition")
}

fn is_function_type(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration" | "arrow_function" | "function_expression"
    )
}

fn is_class_type(v: Variant, kind: &str) -> bool {
    kind == "class_declaration" || (v.is_ts() && kind == "abstract_class_declaration")
}

fn is_variable_type(kind: &str) -> bool {
    matches!(kind, "lexical_declaration" | "variable_declaration")
}

fn is_literal_receiver(kind: &str) -> bool {
    util::is_literal_receiver_kind(kind)
}

fn is_builtin_type(name: &str) -> bool {
    util::is_builtin_type_name(name)
}

/// REACT_COMPONENT_HOCS (tree-sitter.ts, #841).
fn is_react_hoc(callee: &str) -> bool {
    matches!(
        callee,
        "forwardRef" | "memo" | "React.forwardRef" | "React.memo"
    )
}

fn is_vue_collection_name(name: &str) -> bool {
    matches!(name, "actions" | "mutations" | "getters")
}

/// One scope-stack entry (TS keeps node IDs; rows are our equivalent).
type Scope = util::Scope;

/// Extra node properties, per-extract-site (mirrors createNode's `extra`).
type Extra = util::NodeExtra;

type ValueScope<'t> = util::ValueScope<'t>;

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    variant: Variant,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    /// Node id string per row. Rows are unique but IDS COLLIDE for same
    /// (kind, name, line) nodes — routine in minified one-line files — and the
    /// TS extractor's fn-ref dedupe and value-ref self-checks key on the ID,
    /// so parity requires comparing ids, not rows.
    node_ids: Vec<String>,
    /// Function/method names defined in this file (fn-ref flush gate).
    defined_fn_names: HashSet<String>,
    /// Simple names from `imports` refs (fn-ref flush gate).
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<(u32, fnref::Candidate)>,
    // Value-reference bookkeeping (flushValueRefs).
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
    vue_store_file: Option<bool>,
}

const MAX_VALUE_REF_NODES: usize = 20_000;

pub fn extract(file_path: &str, source: &str, language: &str) -> Result<EmitOut, String> {
    let variant = Variant::from_language(language)
        .ok_or_else(|| format!("tsjs walker does not handle language: {language}"))?;
    let grammar = langs::grammar_for(language)
        .ok_or_else(|| format!("no grammar for language: {language}"))?;

    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, language)?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        src: source,
        file_path,
        variant,
        line_starts: util::line_starts(source),
        arena: Arena::default(),
        tables: Tables::default(),
        stack: Vec::new(),
        node_ids: Vec::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
        fs_values: HashMap::new(),
        fs_value_counts: HashMap::new(),
        value_scopes: Vec::new(),
        vue_store_file: None,
    };

    // File node (TreeSitterExtractor.extract): id `file:<path>`, endLine =
    // newline count + 1, isExported explicitly false.
    let base_name = util::emit_file_node(
        file_path,
        source,
        &mut w.arena,
        &mut w.tables,
        &mut w.node_ids,
    );
    w.stack.push(Scope {
        row: 0,
        kind: "file",
        name: base_name,
    });

    w.visit_node(tree.root_node());

    // End-of-file passes, in the TS extract() order.
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.tables, w.arena))
}

impl<'t> Walker<'t> {
    // --- small helpers --------------------------------------------------------

    crate::walker_helper_methods!(class_no_end);
    crate::node_row_emitter_method!();

    fn push_ref(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow::new(
            from_row,
            kind_code,
            self.line_of(node),
            self.col_of(node),
            name_ref,
        ));
        if kind_code == edge_kind_index("imports").unwrap() {
            // Feed the fn-ref flush gate the same way flushFnRefCandidates
            // derives importedNames from `imports` refs.
            util::record_import_name(&mut self.imported_names, name);
        }
    }

    fn push_call_ref(&mut self, name: &str, node: Node) {
        self.push_ref(
            self.top_row(),
            name,
            edge_kind_index("calls").unwrap(),
            node,
        );
    }

    // --- createNode -----------------------------------------------------------

    /// createNode (tree-sitter.ts): id, qualified name from the scope stack,
    /// contains edge from the parent scope, value-ref bookkeeping.
    fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        // endLine body extension: resolveBody only (TS/JS: function-valued
        // class fields whose body nests in the arrow / HOF-wrapped arrow).
        let mut end_line = node.end_position().row as u32 + 1;
        if (kind == "function" || kind == "method")
            && matches!(node.kind(), "public_field_definition" | "field_definition")
        {
            if let Some(body) = resolve_field_body(node) {
                let be = body.end_position().row as u32 + 1;
                if be > end_line {
                    end_line = be;
                }
            }
        }

        let mut extra = extra;
        let qualified = extra.qualified_name.take().unwrap_or_else(|| {
            let parts = self
                .stack
                .iter()
                .filter(|scope| scope.kind != "file")
                .map(|scope| scope.name.as_str());
            util::join_qualified_name(parts, name)
        });

        extra.qualified_name = Some(qualified);
        extra.end_line = Some(end_line);
        let row = self.store_node_row(kind, name, node, extra)?;
        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        self.capture_value_ref_scope(kind, name, row, node);
        Some(row)
    }

    // --- value references (captureValueRefScope / flushValueRefs) --------------

    fn capture_value_ref_scope(
        &mut self,
        kind: &'static str,
        name: &str,
        row: u32,
        node: Node<'t>,
    ) {
        if !self.variant.value_refs() {
            return;
        }
        let parent_kind = self.stack.last().map(|scope| scope.kind);
        if util::captures_value_ref_target(kind, name, parent_kind) {
            util::record_value_ref_target(
                &mut self.fs_values,
                &mut self.fs_value_counts,
                name,
                row,
            );
        }
        if util::is_value_ref_scope_node(kind) {
            self.value_scopes.push(ValueScope {
                row,
                node,
                name: name.to_string(),
            });
        }
    }

    fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if !self.variant.value_refs() || !crate::value_refs_enabled() {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune: count declarators of each target name across the whole
        // tree; more declarators than file-scope nodes ⇒ an inner re-binding
        // shadows the target. (TS/JS declarators are `variable_declarator`;
        // the other kinds in the TS switch belong to other grammars.)
        let decl_counts =
            util::count_shadow_declarations(root, MAX_VALUE_REF_NODES, &targets, |node| {
                node.named_child(0)
                    .filter(|child| {
                        node.kind() == "variable_declarator" && child.kind() == "identifier"
                    })
                    .map(|child| self.text(child).to_string())
            });
        let shadowed = util::shadowed_names(&decl_counts, &counts);
        for nm in shadowed {
            targets.remove(&nm);
        }
        if targets.is_empty() {
            return;
        }

        util::emit_value_ref_edges(
            util::ValueRefEmitContext {
                src: self.src,
                node_ids: &self.node_ids,
                arena: &mut self.arena,
                tables: &mut self.tables,
            },
            &scopes,
            &targets,
            MAX_VALUE_REF_NODES,
            &[],
        );
    }

    // --- function-as-value refs (#756) -----------------------------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let Some(mode) = fnref::dispatch(node.kind()) else {
            return;
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        for (cand, _mode) in fnref::capture(node, mode, self.src) {
            self.fn_ref_cands.push((from, cand));
        }
    }

    /// scanFnRefSubtree: capture-only walk of subtrees the main walkers skip.
    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        let kind = node.kind();
        if depth > 0
            && (is_function_type(kind) || matches!(kind, "lambda_literal" | "lambda_expression"))
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        for child in util::named_children(node) {
            self.scan_fn_ref_subtree(child, depth + 1);
        }
    }

    fn flush_fn_ref_candidates(&mut self) {
        let cands = std::mem::take(&mut self.fn_ref_cands);
        if cands.is_empty() {
            return;
        }
        let candidates = cands
            .into_iter()
            .map(|(from, candidate)| util::FnRefCandidate {
                from,
                name: candidate.name,
                line: candidate.line,
                column_byte: candidate.column_byte,
                row: candidate.row,
            })
            .collect();
        util::flush_fn_ref_candidates(util::FnRefFlushInput {
            candidates,
            file_path: self.file_path,
            node_ids: &self.node_ids,
            src: self.src,
            line_starts: &self.line_starts,
            arena: &mut self.arena,
            tables: &mut self.tables,
            defined_names: &self.defined_fn_names,
            imported_names: &self.imported_names,
        });
    }

    // --- the dispatcher (visitNode) --------------------------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        // Function-as-value capture — independent of the dispatch ladder.
        self.maybe_capture_fn_refs(node);

        if is_function_type(kind) {
            // (the isInsideClassLike + methodTypes overlap is Python/Ruby-only)
            self.extract_function(node, None);
            skip_children = true;
        } else if is_class_type(self.variant, kind) {
            self.extract_class(node);
            skip_children = true;
        } else if is_method_type(self.variant, kind) {
            if classify_ts_class_member(node) == Member::Property {
                let prop = self.extract_property(node);
                if let (Some((row, name)), Some(value)) = (prop, node.child_by_field_name("value"))
                {
                    self.stack.push(Scope {
                        row,
                        kind: "property",
                        name,
                    });
                    self.visit_function_body(value);
                    self.stack.pop();
                }
                self.scan_fn_ref_subtree(node, 0);
            } else {
                self.extract_method(node);
            }
            skip_children = true;
        } else if self.variant.is_ts() && kind == "interface_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if self.variant.is_ts() && kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if self.variant.is_ts() && kind == "type_alias_declaration" {
            skip_children = self.extract_type_alias(node);
        } else if is_variable_type(kind) && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_statement" {
            self.extract_import(node);
        } else if kind == "export_statement" && node.child_by_field_name("source").is_some() {
            // Re-export: `export { X } from './y'`.
            self.emit_re_export_refs(node);
        } else if kind == "export_statement" && self.looks_like_vue_store_file() {
            // Vuex MODULE default export (`export default { actions: {…} }`).
            if let Some(exported) = node.child_by_field_name("value") {
                if matches!(exported.kind(), "object" | "object_expression") {
                    self.extract_store_collection_methods(exported);
                    skip_children = true;
                }
            }
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            self.extract_instantiation(node);
        } else if self.variant.is_ts()
            && matches!(kind, "property_signature" | "method_signature")
            && self.inside_class_like()
        {
            let parent = self.top_row();
            self.extract_type_annotations(node, parent);
        }

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    // --- visitFunctionBody ------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            self.extract_instantiation(node);
        }

        // Local variable type annotations (TS family only).
        if self.variant.is_ts() && kind == "variable_declarator" {
            let owner = self.top_row();
            self.extract_variable_type_annotation(node, owner);
        }

        // Nested NAMED functions become their own nodes.
        if is_function_type(kind) {
            let name = self.extract_name(node);
            let named_binding = node.parent()
                .filter(|p| p.kind() == "variable_declarator")
                .and_then(|p| p.child_by_field_name("name"))
                .is_some_and(|n| n.kind() == "identifier");
            if name != "<anonymous>" || named_binding {
                self.extract_function(node, None);
                return;
            }
        }

        if is_class_type(self.variant, kind) {
            self.extract_class(node);
            return;
        }
        if self.variant.is_ts() && kind == "enum_declaration" {
            self.extract_enum(node);
            return;
        }
        if self.variant.is_ts() && kind == "interface_declaration" {
            self.extract_interface(node);
            return;
        }

        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }

    // --- name / signature / modifier helpers ------------------------------------

    /// extractName / extractNameRaw for the TS/JS configs.
    fn extract_name(&self, node: Node) -> String {
        // javascriptExtractor.resolveName: field_definition names its key the
        // `property` field.
        if !self.variant.is_ts() && node.kind() == "field_definition" {
            if let Some(prop) = node.child_by_field_name("property") {
                return self.text(prop).to_string();
            }
        }
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if matches!(node.kind(), "arrow_function" | "function_expression") {
            return "<anonymous>".to_string();
        }
        for child in util::named_children(node) {
            if matches!(
                child.kind(),
                "identifier" | "type_identifier" | "simple_identifier" | "constant"
            ) {
                return self.text(child).to_string();
            }
        }
        "<anonymous>".to_string()
    }

    /// typescriptExtractor.getSignature / javascriptExtractor.getSignature.
    fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if self.variant.is_ts() {
            if let Some(ret) = node.child_by_field_name("return_type") {
                let ret_text = self.text(ret);
                let stripped = ret_text.strip_prefix(':').unwrap_or(ret_text).trim_start();
                sig.push_str(": ");
                sig.push_str(stripped);
            }
        }
        Some(sig)
    }

    /// typescriptExtractor.getVisibility (TS only — JS has no hook).
    fn visibility_of(&self, node: Node) -> Option<u8> {
        if !self.variant.is_ts() {
            return None;
        }
        for i in 0..node.child_count() {
            let child = node.child(i)?;
            if child.kind() == "accessibility_modifier" {
                return match self.text(child) {
                    "public" => Some(1),
                    "private" => Some(2),
                    "protected" => Some(3),
                    _ => None,
                };
            }
        }
        None
    }

    /// isExported: walk the parent chain for an export_statement.
    fn is_exported(&self, node: Node) -> bool {
        let mut cur = node.parent();
        while let Some(p) = cur {
            if p.kind() == "export_statement" {
                return true;
            }
            cur = p.parent();
        }
        false
    }

    fn has_keyword_child(&self, node: Node, kw: &str) -> bool {
        for i in 0..node.child_count() {
            if let Some(c) = node.child(i) {
                if c.kind() == kw {
                    return true;
                }
            }
        }
        false
    }

    fn is_async(&self, node: Node) -> bool {
        self.has_keyword_child(node, "async")
    }

    /// TS has an isStatic hook; JS does not (None = field absent).
    fn is_static(&self, node: Node) -> Option<bool> {
        if self.variant.is_ts() {
            Some(self.has_keyword_child(node, "static"))
        } else {
            None
        }
    }

    fn is_const_decl(&self, node: Node) -> bool {
        node.kind() == "lexical_declaration" && self.has_keyword_child(node, "const")
    }

    // (extract_* functions continue in impl blocks below)
}

/// classifyTsClassMember (#808): a class field is a METHOD only when its value
/// is callable (arrow / function expression / HOF call wrapping one).
#[derive(PartialEq)]
enum Member {
    Method,
    Property,
}

fn classify_ts_class_member(node: Node) -> Member {
    if !matches!(node.kind(), "public_field_definition" | "field_definition") {
        return Member::Method;
    }
    for i in 0..node.named_child_count() {
        let Some(child) = node.named_child(i) else {
            continue;
        };
        if matches!(child.kind(), "arrow_function" | "function_expression") {
            return Member::Method;
        }
        if child.kind() == "call_expression" {
            if let Some(args) = child.child_by_field_name("arguments") {
                for j in 0..args.named_child_count() {
                    if let Some(arg) = args.named_child(j) {
                        if matches!(arg.kind(), "arrow_function" | "function_expression") {
                            return Member::Method;
                        }
                    }
                }
            }
        }
    }
    Member::Property
}

/// typescriptExtractor.resolveBody / javascriptExtractor.resolveBody: the body
/// of a function-valued class field, nested in the arrow / HOF-wrapped arrow.
fn resolve_field_body(node: Node) -> Option<Node> {
    if !matches!(node.kind(), "public_field_definition" | "field_definition") {
        return None;
    }
    for i in 0..node.named_child_count() {
        let child = node.named_child(i)?;
        if matches!(child.kind(), "arrow_function" | "function_expression") {
            return child.child_by_field_name("body");
        }
        if child.kind() == "call_expression" {
            if let Some(args) = child.child_by_field_name("arguments") {
                for j in 0..args.named_child_count() {
                    if let Some(arg) = args.named_child(j) {
                        if matches!(arg.kind(), "arrow_function" | "function_expression") {
                            return arg.child_by_field_name("body");
                        }
                    }
                }
            }
        }
    }
    None
}

/// resolveBody ?? getChildByField(node, 'body') — the body-walk resolution.
fn body_of(node: Node) -> Option<Node> {
    resolve_field_body(node).or_else(|| node.child_by_field_name("body"))
}
