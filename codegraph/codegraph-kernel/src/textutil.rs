//! Shared utilities for the TS/JS walker: compiled regexes, UTF-16 position
//! conversion, generated-file detection, and small text helpers — each
//! mirroring a specific helper in src/extraction/tree-sitter.ts (noted inline).

use regex::Regex;

use std::collections::{HashMap, HashSet};

use std::sync::OnceLock;

use tree_sitter::{Language, Node, Parser, Tree};

pub const CLASS_LIKE_SCOPE_KINDS: &[&str] =
    &["class", "struct", "interface", "trait", "enum", "module"];

pub const VALUE_REF_SCOPE_KINDS: &[&str] = &["file", "class", "module", "struct", "enum"];

pub const LITERAL_RECEIVER_TYPES: &[&str] = &[
    "string",
    "string_literal",
    "interpreted_string_literal",
    "raw_string_literal",
    "template_string",
    "concatenated_string",
    "formatted_string",
    "f_string",
    "line_string_literal",
    "string_content",
    "heredoc_body",
    "number",
    "number_literal",
    "integer",
    "integer_literal",
    "float",
    "float_literal",
    "int_literal",
    "decimal_integer_literal",
    "real_literal",
    "char_literal",
    "character_literal",
    "rune_literal",
    "regex",
    "regex_literal",
    "true",
    "false",
    "boolean_literal",
    "bool_literal",
    "none",
    "null",
    "nil",
    "null_literal",
    "undefined",
    "list",
    "list_literal",
    "array",
    "array_literal",
    "array_creation_expression",
    "dictionary",
    "dict_literal",
    "object",
    "tuple",
    "set",
];

pub const BUILTIN_TYPE_NAMES: &[&str] = &[
    "string",
    "number",
    "boolean",
    "void",
    "null",
    "undefined",
    "never",
    "any",
    "unknown",
    "object",
    "symbol",
    "bigint",
    "true",
    "false",
    "str",
    "bool",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "f32",
    "f64",
    "char",
    "int",
    "long",
    "short",
    "byte",
    "float",
    "double",
    "int8",
    "int16",
    "int32",
    "int64",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "float32",
    "float64",
    "complex64",
    "complex128",
    "rune",
    "error",
    "Int",
    "Long",
    "Short",
    "Byte",
    "Float",
    "Double",
    "Boolean",
    "Char",
    "Unit",
    "String",
    "Any",
    "AnyRef",
    "AnyVal",
    "Nothing",
    "Null",
];

pub fn is_class_like_scope_kind(kind: &str) -> bool {
    CLASS_LIKE_SCOPE_KINDS.contains(&kind)
}

pub fn is_value_ref_scope_kind(kind: &str) -> bool {
    VALUE_REF_SCOPE_KINDS.contains(&kind)
}

pub fn captures_value_ref_target(kind: &str, name: &str, parent_kind: Option<&str>) -> bool {
    (kind == "constant" || kind == "variable")
        && utf16_len(name) >= 3
        && has_upper_or_underscore().is_match(name)
        && parent_kind.is_some_and(is_value_ref_scope_kind)
}

pub fn record_value_ref_target(
    values: &mut HashMap<String, u32>,
    counts: &mut HashMap<String, u32>,
    name: &str,
    row: u32,
) {
    values.insert(name.to_string(), row);
    *counts.entry(name.to_string()).or_insert(0) += 1;
}

/// Record a value-reference target when the declaration is in a shareable
/// file/type scope. Keeping the predicate and the two-map update together
/// prevents each language adapter from repeating the same bookkeeping block.
pub fn record_value_ref_target_if(
    state: &mut WalkerState<'_>,
    kind: &str,
    name: &str,
    parent_kind: Option<&str>,
    row: u32,
) {
    if captures_value_ref_target(kind, name, parent_kind) {
        record_value_ref_target(&mut state.fs_values, &mut state.fs_value_counts, name, row);
    }
}

/// Register the bookkeeping that follows a successful declaration row.
/// Language walkers can opt a declaration into the shared function-name gate
/// while retaining their own grammar-specific extraction decisions.
pub fn record_node_bookkeeping<'tree>(
    state: &mut WalkerState<'tree>,
    kind: &str,
    name: &str,
    node: Node<'tree>,
    row: u32,
    register_function_name: bool,
) {
    if register_function_name {
        state.defined_fn_names.insert(name.to_string());
    }
    let parent_kind = state.stack.last().map(|scope| scope.kind);
    record_value_ref_target_if(state, kind, name, parent_kind, row);
    if is_value_ref_scope_node(kind) {
        state.value_scopes.push(ValueScope {
            row,
            node,
            name: name.to_string(),
        });
    }
}

/// Emit a declaration row and immediately register its shared bookkeeping.
/// Keeping the two operations together removes the repeated adapter-level
/// borrow/row/record sequence while leaving each grammar's extraction policy
/// at the call site.
pub fn emit_recorded_node_row<'tree>(
    state: &mut WalkerState<'tree>,
    kind: &'static str,
    name: &str,
    node: Node<'tree>,
    extra: NodeExtra,
    register_function_name: bool,
) -> Option<u32> {
    let row = emit_node_row(state, kind, name, node, extra)?;
    record_node_bookkeeping(state, kind, name, node, row, register_function_name);
    Some(row)
}

pub fn is_value_ref_scope_node(kind: &str) -> bool {
    matches!(kind, "function" | "method" | "constant" | "variable")
}

pub fn is_literal_receiver_kind(kind: &str) -> bool {
    LITERAL_RECEIVER_TYPES.contains(&kind)
}

pub fn is_builtin_type_name(name: &str) -> bool {
    BUILTIN_TYPE_NAMES.contains(&name)
}

/// Common position/scope methods used by every native language walker. The
/// macro keeps each adapter's `impl Walker` focused on grammar behavior while
/// retaining the existing method names at call sites.
#[macro_export]
macro_rules! walker_helper_methods {
    (class) => {
        fn text(&self, node: ::tree_sitter::Node) -> &'t str {
            $crate::textutil::source_text(self.src, node)
        }
        fn line_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_line(node)
        }
        fn col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_column(self.src, &self.line_starts, node)
        }
        fn end_col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_end_column(self.src, &self.line_starts, node)
        }
        fn top_row(&self) -> u32 {
            $crate::textutil::top_scope_row(&self.stack)
        }
        fn inside_class_like(&self) -> bool {
            $crate::textutil::inside_class_like(&self.stack)
        }
    };
    (class_no_end) => {
        fn text(&self, node: ::tree_sitter::Node) -> &'t str {
            $crate::textutil::source_text(self.src, node)
        }
        fn line_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_line(node)
        }
        fn col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_column(self.src, &self.line_starts, node)
        }
        fn top_row(&self) -> u32 {
            $crate::textutil::top_scope_row(&self.stack)
        }
        fn inside_class_like(&self) -> bool {
            $crate::textutil::inside_class_like(&self.stack)
        }
    };
    (class_no_line) => {
        fn text(&self, node: ::tree_sitter::Node) -> &'t str {
            $crate::textutil::source_text(self.src, node)
        }
        fn col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_column(self.src, &self.line_starts, node)
        }
        fn top_row(&self) -> u32 {
            $crate::textutil::top_scope_row(&self.stack)
        }
        fn inside_class_like(&self) -> bool {
            $crate::textutil::inside_class_like(&self.stack)
        }
    };
    (state_class_no_line) => {
        fn text(&self, node: ::tree_sitter::Node) -> &'t str {
            $crate::textutil::source_text(self.state.src, node)
        }
        fn col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_column(self.state.src, &self.state.line_starts, node)
        }
        fn top_row(&self) -> u32 {
            $crate::textutil::top_scope_row(&self.state.stack)
        }
        fn inside_class_like(&self) -> bool {
            $crate::textutil::inside_class_like(&self.state.stack)
        }
    };
    (state_class_no_position) => {
        fn text(&self, node: ::tree_sitter::Node) -> &'t str {
            $crate::textutil::source_text(self.state.src, node)
        }
        fn top_row(&self) -> u32 {
            $crate::textutil::top_scope_row(&self.state.stack)
        }
        fn inside_class_like(&self) -> bool {
            $crate::textutil::inside_class_like(&self.state.stack)
        }
    };
    (state_class) => {
        fn text(&self, node: ::tree_sitter::Node) -> &'t str {
            $crate::textutil::source_text(self.state.src, node)
        }
        fn line_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_line(node)
        }
        fn col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_column(self.state.src, &self.state.line_starts, node)
        }
        fn end_col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_end_column(self.state.src, &self.state.line_starts, node)
        }
        fn top_row(&self) -> u32 {
            $crate::textutil::top_scope_row(&self.state.stack)
        }
        fn inside_class_like(&self) -> bool {
            $crate::textutil::inside_class_like(&self.state.stack)
        }
    };
    (no_class) => {
        fn text(&self, node: ::tree_sitter::Node) -> &'t str {
            $crate::textutil::source_text(self.src, node)
        }
        fn line_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_line(node)
        }
        fn col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_column(self.src, &self.line_starts, node)
        }
        fn end_col_of(&self, node: ::tree_sitter::Node) -> u32 {
            $crate::textutil::node_end_column(self.src, &self.line_starts, node)
        }
        fn top_row(&self) -> u32 {
            $crate::textutil::top_scope_row(&self.stack)
        }
    };
}

/// Adds the shared node-row storage boundary to walkers that keep the common
/// source, scope, arena, table, and node-id fields directly on `self`.
#[macro_export]
macro_rules! node_row_emitter_method {
    () => {
        fn store_node_row(
            &mut self,
            kind: &'static str,
            name: &str,
            node: ::tree_sitter::Node<'t>,
            extra: $crate::textutil::NodeExtra,
        ) -> Option<u32> {
            $crate::textutil::emit_node_row_in(
                $crate::textutil::NodeRowEmitContext {
                    file_path: self.file_path,
                    src: self.src,
                    line_starts: &self.line_starts,
                    stack: &self.stack,
                    arena: &mut self.arena,
                    tables: &mut self.tables,
                    node_ids: &mut self.node_ids,
                },
                kind,
                name,
                node,
                extra,
            )
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_cols() {
        let src = "aé😀b";
        // 'a'=1, 'é'=1, '😀'=2 utf16 units; bytes: a=1, é=2, 😀=4
        assert_eq!(utf16_len(src), 5);
        let starts = line_starts(src);
        assert_eq!(col16(src, &starts, 0, 1), 1); // after 'a'
        assert_eq!(col16(src, &starts, 0, 3), 2); // after 'é'
        assert_eq!(col16(src, &starts, 0, 7), 4); // after '😀'
    }

    #[test]
    fn init_sig_short_and_long() {
        assert_eq!(init_signature("[1, 2]"), "= [1, 2]");
        let long = "x".repeat(150);
        let sig = init_signature(&long);
        assert!(sig.starts_with("= "));
        assert!(sig.ends_with("..."));
        assert_eq!(utf16_len(&sig[2..sig.len() - 3]), 100);
    }

    #[test]
    fn generated_patterns() {
        assert!(is_generated_file("src/api.generated.ts"));
        assert!(is_generated_file("vendor/jquery.min.js"));
        assert!(!is_generated_file("src/app.ts"));
    }
}

mod state;
pub use state::*;
mod text;
pub use text::*;
mod syntax;
pub use syntax::*;
mod references;
pub use references::*;
mod emission;
pub use emission::*;
