//! Ruby extraction — a faithful Rust port of `TreeSitterExtractor`'s Ruby
//! paths (src/extraction/tree-sitter.ts) plus languages/ruby.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug,
//! including the load-bearing oddities this file preserves on purpose:
//! `importTypes: ['call']` funnels EVERY non-body call into extractImport (so
//! class-body DSL like `attr_accessor`, `has_many`, `define_method` and its
//! whole block emit NOTHING), hook-handled modules MULTIPLY-CAPTURE fn-ref
//! containers (each nesting level re-scans its subtree after popping), the
//! sibling-scan visibility trio (bare `private` is invisible; `private :sym` /
//! `private def x` poison every later sibling def; the def inside
//! `private def` stays public), brace-block bodies (`block_body`) are
//! invisible to bare-call extraction while `do…end` bodies emit, and the
//! value-ref DFS visits statements in REVERSE source order. Positions in
//! UTF-16 code units. Files with parse errors defer to wasm (~0% incidence).

use crate::buffers::{edge_kind_index, EmitOut, RefRow, NONE_STR, REF_FLAG_FILE_PATH};
use crate::docstring::preceding_docstring;
use crate::textutil as util;
use crate::textutil::{WalkerHelpers, WalkerScope};
use regex::Regex;
use std::ops::{Deref, DerefMut};
use std::sync::OnceLock;
use tree_sitter::Node;

const MAX_VALUE_REF_NODES: usize = 20_000;

/// isRubyHookCall (function-ref.ts:282-286).
fn is_ruby_hook_call(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(skip_)?(before|after|around)_[a-z_]+$").unwrap());
    re.is_match(name)
        || matches!(
            name,
            "validate" | "set_callback" | "helper_method" | "rescue_from"
        )
}

/// The hook-DSL symbol shape (`/^[A-Za-z_][A-Za-z0-9_?!]*$/`).
fn ruby_sym_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_?!]*$").unwrap())
}

/// Node `path.posix.normalize` for the require_relative path join
/// (emitRubyRequireRefs): resolve `.`/`..` lexically, collapse `//`, keep
/// unresolvable leading `..`s, preserve a trailing slash.
fn posix_normalize(p: &str) -> String {
    let is_abs = p.starts_with('/');
    let had_trailing = p.len() > 1 && p.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if matches!(out.last(), Some(&last) if last != "..") {
                    out.pop();
                } else if !is_abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut joined = out.join("/");
    if is_abs {
        joined = format!("/{joined}");
    }
    if joined.is_empty() || joined == "/" {
        return if is_abs {
            "/".to_string()
        } else {
            ".".to_string()
        };
    }
    if had_trailing {
        joined.push('/');
    }
    joined
}

type Scope = util::Scope;
type Extra = util::NodeExtra;

pub struct Walker<'t> {
    state: util::WalkerState<'t>,
}

impl<'t> Deref for Walker<'t> {
    type Target = util::WalkerState<'t>;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

impl<'t> DerefMut for Walker<'t> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.state
    }
}

impl<'t> WalkerHelpers<'t> for Walker<'t> {
    fn walker_state(&self) -> &util::WalkerState<'t> {
        &self.state
    }
}

impl<'t> WalkerScope<'t> for Walker<'t> {
    fn walker_state_mut(&mut self) -> &mut util::WalkerState<'t> {
        &mut self.state
    }
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("ruby").ok_or("no ruby grammar")?;
    let t0 = std::time::Instant::now();
    let tree = util::parse_tree(&grammar, source, "ruby")?;
    util::reject_error_tree(
        &tree,
        "defer: parse tree contains errors — wasm recovery is canonical",
    )?;

    let mut w = Walker {
        state: util::WalkerState::new(file_path, source),
    };

    let base_name = {
        let state = &mut w.state;
        util::emit_file_node(
            file_path,
            source,
            &mut state.arena,
            &mut state.tables,
            &mut state.node_ids,
        )
    };
    w.stack.push(Scope {
        row: 0,
        kind: "file",
        name: base_name.to_string(),
    });

    w.visit_node(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    Ok(util::finish_emit(t0, w.state.tables, w.state.arena))
}

impl<'t> Walker<'t> {
    fn push_ref(&mut self, from_row: u32, name: &str, kind_code: u8, line: u32, column: u32) {
        util::emit_state_ref(&mut self.state, from_row, name, kind_code, line, column);
    }

    fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        util::emit_state_ref_at(&mut self.state, from_row, name, kind_code, node);
    }

    // --- createNode ------------------------------------------------------------

    fn create_node(
        &mut self,
        kind: &'static str,
        name: &str,
        node: Node<'t>,
        extra: Extra,
    ) -> Option<u32> {
        let row = util::emit_node_row(&mut self.state, kind, name, node, extra)?;

        util::record_node_bookkeeping(
            &mut self.state,
            kind,
            name,
            node,
            row,
            matches!(kind, "function" | "method"),
        );
        Some(row)
    }

    fn extract_name(&self, node: Node) -> String {
        util::declaration_name(node, self.src).unwrap_or_else(|| "<anonymous>".to_string())
    }

    /// rubyExtractor.getVisibility — walk the previousNamedSibling chain
    /// (unbounded, through non-matching siblings); the first `call` sibling
    /// whose `method` text is private/protected/public decides; else public.
    /// Bug-for-bug: a BARE `private` line parses as identifier (invisible),
    /// and a matching call poisons every later sibling def regardless of
    /// ruby's actual arg-scoped semantics.
    fn visibility_of(&self, node: Node) -> u8 {
        let mut sibling = node.prev_named_sibling();
        while let Some(s) = sibling {
            if s.kind() == "call" {
                if let Some(method) = s.child_by_field_name("method") {
                    match self.text(method) {
                        "private" => return 2,
                        "protected" => return 3,
                        "public" => return 1,
                        _ => {}
                    }
                }
            }
            sibling = s.prev_named_sibling();
        }
        1 // public
    }

    // --- the visitNode hook (languages/ruby.ts:19-76) ---------------------------

    /// Returns true when the hook handled the node (mixin call or module).
    /// The DISPATCHER then runs scan_fn_ref_subtree on the handled subtree —
    /// the source of the module multiply-capture quirk (scan runs with the
    /// module already POPPED, so candidates re-attribute to the outer scope).
    fn try_visit_hook(&mut self, node: Node<'t>) -> bool {
        let kind = node.kind();
        if kind == "call" && node.child_by_field_name("receiver").is_none() {
            if let Some(method) = node.child_by_field_name("method") {
                if matches!(self.text(method), "include" | "extend" | "prepend") {
                    let args = node.child_by_field_name("arguments").or_else(|| {
                        util::named_children(node).find(|c| c.kind() == "argument_list")
                    });
                    // (nodeStack is never empty — the file node is pushed.)
                    if let Some(args) = args {
                        let parent = self.top_row();
                        let implements = edge_kind_index("implements").unwrap();
                        let line = util::node_line(node);
                        let col = util::node_column(self.src, &self.line_starts, node);
                        for arg in util::named_children(args) {
                            // `Mod` is constant, `Foo::Bar` is scope_resolution;
                            // `extend self` / dynamic args are skipped. Unlike
                            // every other extraction ref, the hook sets
                            // `filePath: ctx.filePath` — flagged on the wire.
                            if matches!(arg.kind(), "constant" | "scope_resolution") {
                                let arg_text = self.text(arg).to_string();
                                let name_ref = self.arena.put(&arg_text);
                                self.tables.push_ref_flagged(
                                    &RefRow {
                                        from_idx: parent,
                                        kind: implements,
                                        line,
                                        column: col,
                                        reference_name: name_ref,
                                        candidates: NONE_STR,
                                        from_id_str: NONE_STR,
                                    },
                                    REF_FLAG_FILE_PATH,
                                );
                            }
                        }
                        return true;
                    }
                    // no args node → hook declines (falls to extractImport → nothing)
                }
            }
        }

        if kind != "module" {
            return false;
        }
        let Some(name_node) = node.child_by_field_name("name") else {
            return false;
        };
        // `module A::B` keeps the scope_resolution text verbatim as the name.
        let name = self.text(name_node).to_string();
        let Some(row) = self.create_node("module", &name, node, Extra::default()) else {
            return false;
        };
        let body = node.child_by_field_name("body");
        self.with_scope(row, "module", name, |walker| {
            if let Some(body) = body {
                for child in util::named_children(body) {
                    walker.visit_node(child);
                }
            }
        });
        true
    }

    // --- the dispatcher (visitNode, Ruby-relevant branches) ----------------------

    fn visit_node(&mut self, node: Node<'t>) {
        // Language hook FIRST (tree-sitter.ts:943) — a handled subtree is
        // scanned for fn-ref candidates and never reaches the ladder (or the
        // maybeCaptureFnRefs call below).
        if self.try_visit_hook(node) {
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "method" {
            // functionTypes ∩ methodTypes: inside class-like (module counts!)
            // ⇒ method, else function.
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "class" {
            self.extract_class(node);
            skip_children = true;
        } else if kind == "singleton_method" {
            // methodTypes-only: extractMethod's 1747 gate bounces a top-level
            // `def self.x` to extractFunction — a plain function named x (the
            // receiver object is ignored everywhere).
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "assignment"
            && (!self.inside_class_like() || self.is_class_scope_constant_assignment(node))
        {
            // File scope: identifier AND constant LHS extract; class/module
            // scope: ONLY constant LHS (isClassScopeConstantAssignment). The
            // RHS is never walked (no instantiates/calls from initializers).
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "call" {
            // importTypes:['call'] — EVERY non-body call funnels here. Only
            // require/require_relative-with-string emit; everything else is
            // invisible (children still visited: no skipChildren).
            self.extract_import(node);
        }
        // `singleton_class` (`class << self`), `alias`, top-level `if`/`begin`,
        // `uninterpreted`, operator_assignment: no branch — recursed.

        if !skip_children {
            for child in util::named_children(node) {
                self.visit_node(child);
            }
        }
    }

    /// isClassScopeConstantAssignment (tree-sitter.ts:1508).
    fn is_class_scope_constant_assignment(&self, node: Node) -> bool {
        let left = node
            .child_by_field_name("left")
            .or_else(|| node.named_child(0));
        left.map(|l| l.kind() == "constant").unwrap_or(false)
    }

    // --- visitFunctionBody ------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call" {
            self.extract_call(node);
        } else if let Some(bare) = self.bare_call_name(node) {
            // extractBareCall: statement-level identifiers in BLOCK_PARENTS
            // bodies (`do…end` = body_statement; brace blocks are block_body —
            // NOT in the set, so `5.times { beep }` emits nothing for beep).
            let name = bare.to_string();
            let from = self.top_row();
            self.push_ref_at(from, &name, edge_kind_index("calls").unwrap(), node);
        }

        // (No INSTANTIATION_KINDS for ruby — `.new` is handled in extract_call;
        // extractStaticMemberRef is gated off; no type annotations.)

        // Nested NAMED defs become their own function nodes; classes extract.
        // A `module` inside a body mints NOTHING (the visitNode hook does not
        // run here) — its children just recurse. Same for singleton_method
        // (functionTypes-only check): unmatched, recursed.
        if kind == "method" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }
        if kind == "class" {
            self.extract_class(node);
            return;
        }

        for child in util::named_children(node) {
            self.visit_for_calls_and_structure(child);
        }
    }

    /// rubyExtractor.extractBareCall (languages/ruby.ts:77-105).
    fn bare_call_name(&self, node: Node<'t>) -> Option<&'t str> {
        if node.kind() != "identifier" {
            return None;
        }
        let parent = node.parent()?;
        if !matches!(
            parent.kind(),
            "body_statement" | "then" | "else" | "do" | "begin" | "rescue" | "ensure" | "when"
        ) {
            return None;
        }
        let name = self.text(node);
        if matches!(
            name,
            "true" | "false" | "nil" | "self" | "super" | "__FILE__" | "__LINE__" | "__dir__"
        ) {
            return None;
        }
        // charCodeAt(0) in [65,90] — ASCII uppercase only (constants).
        let first = name.as_bytes().first().copied().unwrap_or(0);
        if (65..=90).contains(&first) {
            return None;
        }
        Some(name)
    }

    // --- extractors --------------------------------------------------------------

    fn extract_function(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None, // no getSignature hook
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };
        // (ruby ∉ TYPE_ANNOTATION_LANGUAGES; decorators are a structural no-op)
        let body = node.child_by_field_name("body");
        self.with_scope(row, "function", name, |walker| {
            if let Some(body) = body {
                walker.visit_function_body(body);
            }
        });
        // `parameters` are NEVER walked — a call in a default value emits nothing.
    }

    fn extract_method(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };
        let body = node.child_by_field_name("body");
        self.with_scope(row, "method", name, |walker| {
            if let Some(body) = body {
                walker.visit_function_body(body);
            }
        });
    }

    fn extract_class(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };

        // extractInheritance: the `superclass` clause — ONE extends ref, FULL
        // text (scope_resolution / even `Struct.new(:a)` expressions verbatim),
        // positioned at the type child.
        let extends_kind = edge_kind_index("extends").unwrap();
        for child in util::named_children(node) {
            if child.kind() == "superclass" {
                if let Some(target) = child.named_child(0) {
                    let tname = self.text(target).to_string();
                    self.push_ref_at(row, &tname, extends_kind, target);
                }
            }
        }

        // Bodiless `class X; end` has no body field → the class node itself
        // is walked (name/superclass children revisit harmlessly).
        let body = node.child_by_field_name("body").unwrap_or(node);
        self.with_scope(row, "class", name, |walker| {
            for child in util::named_children(body) {
                walker.visit_node(child);
            }
        });
    }

    /// extractVariable — the python/ruby assignment branch (2709-2727):
    /// identifier or constant LHS mints a `variable` node (no isConst hook —
    /// `MAX = 3` is kind variable) at the ASSIGNMENT node's position, with the
    /// `= <first 100 utf16 units>` initializer signature.
    fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let left = node
            .child_by_field_name("left")
            .or_else(|| node.named_child(0));
        let right = node
            .child_by_field_name("right")
            .or_else(|| node.named_child(1));
        let Some(left) = left else { return };
        if !matches!(left.kind(), "identifier" | "constant") {
            return;
        }
        let name = self.text(left).to_string();
        let signature = right.map(|r| util::init_signature(self.text(r)));
        self.create_node(
            "variable",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility: None,
                ..Extra::default()
            },
        );
    }

    /// extractImport — every non-body `call` lands here (importTypes:['call']).
    /// Hook (languages/ruby.ts:123): FIRST identifier named child must read
    /// require/require_relative (a lowercase receiver is found first and
    /// declines; a constant receiver — `Kernel.require "x"` — reaches the
    /// method identifier and IS a require); argument_list → string →
    /// string_content → moduleName. Then the generic imports ref and
    /// emitRubyRequireRefs' path ref.
    fn extract_import(&mut self, node: Node<'t>) {
        let ident = util::named_children(node).find(|c| c.kind() == "identifier");
        let Some(ident) = ident else { return };
        let mname = self.text(ident);
        if mname != "require" && mname != "require_relative" {
            return;
        }
        let arg_list = util::named_children(node).find(|c| c.kind() == "argument_list");
        let Some(arg_list) = arg_list else { return };
        let string = util::named_children(arg_list).find(|c| c.kind() == "string");
        let Some(string) = string else { return };
        let content = util::named_children(string).find(|c| c.kind() == "string_content");
        let Some(content) = content else { return };

        // Interpolated paths take the FIRST string_content only — moduleName
        // `interp/` (+ a garbage `interp/.rb` path ref) — deterministic quirk.
        let module_name = self.text(content).to_string();
        let import_text = self.text(node).trim().to_string();
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
        let imports_kind = edge_kind_index("imports").unwrap();
        self.push_ref_at(parent, &module_name.clone(), imports_kind, node);

        // emitRubyRequireRefs (3532): the file-path ref. Bare gem/stdlib
        // requires (no `/`) emit nothing; paths get `.rb` appended.
        let req = self.text(content).trim();
        if req.is_empty() {
            return;
        }
        let ref_path = if mname == "require_relative" {
            let dir = match self.file_path.rfind('/') {
                Some(i) => &self.file_path[..i],
                None => "",
            };
            let joined = if dir.is_empty() {
                req.to_string()
            } else {
                format!("{dir}/{req}")
            };
            posix_normalize(&joined)
        } else {
            req.to_string()
        };
        if !ref_path.contains('/') {
            return;
        }
        let ref_path = if ref_path.ends_with(".rb") {
            ref_path
        } else {
            format!("{ref_path}.rb")
        };
        self.push_ref_at(parent, &ref_path, imports_kind, node);
    }

    /// extractCall — the bespoke ruby branch (tree-sitter.ts:3905-3960),
    /// reached only from the body walker.
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let method_name = match node.child_by_field_name("method") {
            Some(m) => self.text(m),
            None => "",
        };
        if method_name.is_empty() {
            return; // operator/element-reference call with no method name
        }
        let line = util::node_line(node);
        let col = util::node_column(self.src, &self.line_starts, node);
        let calls_kind = edge_kind_index("calls").unwrap();

        let Some(receiver) = node.child_by_field_name("receiver") else {
            // Bare `foo(...)` — just the method name.
            self.push_ref(caller, method_name, calls_kind, line, col);
            return;
        };
        let receiver_name = self.text(receiver);

        // `Foo.new` / `NS::Widget.new` → instantiates ref to the LAST `::`
        // segment; a non-capitalized receiver falls through to a calls ref
        // (`lower.new`).
        if method_name == "new" {
            let class_name = match receiver_name.rfind("::") {
                Some(i) => &receiver_name[i + 2..],
                None => receiver_name,
            };
            if class_name
                .as_bytes()
                .first()
                .map(|b| b.is_ascii_uppercase())
                .unwrap_or(false)
            {
                self.push_ref(
                    caller,
                    class_name,
                    edge_kind_index("instantiates").unwrap(),
                    line,
                    col,
                );
                return;
            }
        }

        // SKIP_RECEIVERS by TEXT — ruby's set is {self, super} only. `&.`
        // joins with a plain `.`; chains/literals keep raw receiver text.
        let skip = matches!(receiver_name, "self" | "super");
        let callee = if skip {
            method_name.to_string()
        } else {
            format!("{receiver_name}.{method_name}")
        };
        self.push_ref(caller, &callee, calls_kind, line, col);

        // Capitalized constant receiver (`Klass.static_call`, `RETRY_MAX.times`)
        // → an ADDITIONAL references ref at the RECEIVER's position.
        // (scope_resolution receivers get none — type ≠ constant.)
        if !skip && receiver.kind() == "constant" {
            self.push_ref_at(
                caller,
                receiver_name,
                edge_kind_index("references").unwrap(),
                receiver,
            );
        }
    }

    // --- function-as-value refs (RUBY_SPEC, function-ref.ts:262) -----------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            PairValue,
        }
        let mode = match node.kind() {
            "argument_list" => Mode::Args,
            "pair" => Mode::PairValue,
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            Mode::Args => {
                values.extend(util::named_children(node));
            }
            Mode::PairValue => {
                let value = util::field_or_last_named(node, "value");
                if let Some(v) = value {
                    values.push(v);
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue for RUBY_SPEC: idTypes EMPTY (bare identifiers never
    /// qualify); `block_argument` is a transparent layer; specials are the
    /// `method(:sym)` call form and hook-DSL `simple_symbol`s.
    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "block_argument" => {
                for child in util::named_children(v) {
                    self.normalize_fn_ref_value(child, from, depth + 1);
                }
            }
            "call" => {
                // `method(:target_cb)` — method field literally `method`, one
                // simple_symbol argument. Candidate = bare symbol name at the
                // SYMBOL node (gated at flush on defined-in-file ∪ imports).
                let Some(method) = v.child_by_field_name("method") else {
                    return;
                };
                if self.text(method) != "method" {
                    return;
                }
                let Some(args) = v.child_by_field_name("arguments") else {
                    return;
                };
                if args.named_child_count() != 1 {
                    return;
                }
                let Some(sym) = args.named_child(0) else {
                    return;
                };
                if sym.kind() != "simple_symbol" {
                    return;
                }
                let name = self.text(sym).strip_prefix(':').unwrap_or(self.text(sym));
                if !name.is_empty() {
                    self.push_fn_ref_cand(from, name, sym);
                }
            }
            "simple_symbol" => {
                // Hook-DSL symbols (`before_action :authenticate`) → class-
                // scoped `this.<sym>` candidates (always flushed).
                let Some(call) = ruby_enclosing_call(v) else {
                    return;
                };
                let Some(method) = call.child_by_field_name("method") else {
                    return;
                };
                if !is_ruby_hook_call(self.text(method)) {
                    return;
                }
                let sym = self.text(v).strip_prefix(':').unwrap_or(self.text(v));
                if !ruby_sym_re().is_match(sym) {
                    return;
                }
                let name = format!("this.{sym}");
                self.push_fn_ref_cand(from, &name, v);
            }
            _ => {}
        }
    }

    fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node) {
        util::record_fn_ref_candidate(&mut self.fn_ref_cands, from, name, node);
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        let stop = |node: Node, depth: u32| {
            depth > 0
                && matches!(
                    node.kind(),
                    "method"
                        | "arrow_function"
                        | "function_expression"
                        | "lambda_literal"
                        | "lambda_expression"
                )
        };
        let mut visit = |node: Node<'t>, _depth: u32| self.maybe_capture_fn_refs(node);
        util::walk_named_subtree(node, depth, 12, &stop, &mut visit);
    }

    fn flush_fn_ref_candidates(&mut self) {
        util::flush_state_fn_ref_candidates(&mut self.state);
    }

    // --- value references (crib of python.rs — same traversal, same cases) ------

    fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if !crate::value_refs_enabled() {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune — ruby's declarator shape is `assignment`. A
        // constant-typed LHS has no named children → constants are never
        // counted (never pruned); identifier LHSes (and each identifier of a
        // multiple-assign left) bump.
        let decl_counts =
            util::count_shadow_declarations_many(root, MAX_VALUE_REF_NODES, &targets, |node| {
                util::assignment_declared_names(node, self.src)
            });
        util::prune_shadowed_targets(&mut targets, &decl_counts, &counts);
        if targets.is_empty() {
            return;
        }

        let state = &mut self.state;
        util::emit_value_ref_edges(
            util::ValueRefEmitContext {
                src: state.src,
                node_ids: &state.node_ids,
                arena: &mut state.arena,
                tables: &mut state.tables,
            },
            &scopes,
            &targets,
            MAX_VALUE_REF_NODES,
            &[],
        );
    }
}

/// The Ruby `call` node whose argument_list (or keyword pair) contains `node`
/// — nearest `call` ancestor within 4 parent hops (function-ref.ts:837).
fn ruby_enclosing_call(node: Node) -> Option<Node> {
    let mut cur = node.parent();
    for _ in 0..4 {
        let c = cur?;
        if c.kind() == "call" {
            return Some(c);
        }
        cur = c.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::posix_normalize;

    #[test]
    fn normalize_matches_node_posix() {
        assert_eq!(posix_normalize("lib/foo/../bar/baz"), "lib/bar/baz");
        assert_eq!(posix_normalize("../x/./y"), "../x/y");
        assert_eq!(posix_normalize("a/../.."), "..");
        assert_eq!(posix_normalize("./foo/bar"), "foo/bar");
        assert_eq!(posix_normalize("a//b"), "a/b");
        assert_eq!(posix_normalize("a/b/"), "a/b/");
    }
}
