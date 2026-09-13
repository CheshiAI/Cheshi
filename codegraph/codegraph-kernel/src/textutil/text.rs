//! text support for textutil.

use super::*;

/// JavaScript's `\s` character class.  The native walkers use this when they
/// reproduce the web-tree-sitter chained-call normalization exactly; keeping
/// the predicate here prevents each language adapter from carrying its own
/// copy of the Unicode table.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn strip_js_whitespace(s: &str) -> String {
    s.chars()
        .filter(|character| !is_js_whitespace(*character))
        .collect()
}

pub fn is_ascii_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

pub fn is_capitalized_identifier(name: &str) -> bool {
    is_ascii_identifier(name)
        && name
            .as_bytes()
            .first()
            .is_some_and(|first| first.is_ascii_uppercase())
}

pub fn capitalized_identifier_text<'a>(node: Node, src: &'a str) -> Option<&'a str> {
    if !matches!(
        node.kind(),
        "identifier" | "type_identifier" | "simple_identifier" | "name" | "scoped_type_identifier"
    ) {
        return None;
    }
    let text = source_text(src, node);
    is_capitalized_identifier(text).then_some(text)
}

pub fn strip_trailing_nullable(name: &str) -> String {
    name.trim_end_matches('?').to_string()
}

pub fn strip_non_nested_generic_args(name: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").expect("generic argument pattern"))
        .replace_all(name, "")
        .into_owned()
}

pub fn join_qualified_name<'a, I>(parts: I, name: &str) -> String
where
    I: IntoIterator<Item = &'a str>,
{
    let mut qualified = parts.into_iter().collect::<Vec<_>>().join("::");
    if !qualified.is_empty() {
        qualified.push_str("::");
    }
    qualified.push_str(name);
    qualified
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        pub fn $name() -> &'static Regex {
            static RE: OnceLock<Regex> = OnceLock::new();
            RE.get_or_init(|| Regex::new($pat).expect(concat!("regex ", stringify!($name))))
        }
    };
}

// RTK_HOOK_NAME_RE (tree-sitter.ts)
re!(rtk_hook_name, r"^use[A-Z][A-Za-z0-9]*(?:Query|Mutation)$");

// reactComponentHoc's styled test
re!(styled_callee, r"^styled\b");

// PascalCase component gate (#841)
re!(pascal_case, r"^[A-Z]");

// extractCall parenthesized-conversion normalization
re!(paren_conversion, r"^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$");

// flushFnRefCandidates SIMPLE_NAME
re!(simple_name, r"^[A-Za-z_$][A-Za-z0-9_$]*$");

// flushFnRefCandidates QUALIFIED_IMPORT
re!(
    qualified_import,
    r"^[A-Za-z_$][A-Za-z0-9_$.\\]*[.\\]([A-Za-z_$][A-Za-z0-9_$]*)$"
);

// captureFnRefCandidates rhs param-storage skip — trailing identifier of LHS
re!(lhs_last_name, r"([A-Za-z_$][A-Za-z0-9_$]*)\s*$");

// extractTsTupleContractNames identifier test
re!(ident_dollar, r"^[A-Za-z_$][A-Za-z0-9_$]*$");

// looksLikeVueStoreFile signal (VUE_STORE_FILE_SIGNAL)
re!(
    vue_store_signal,
    r"\bdefineStore\b|\bcreateStore\b|\bVuex\b|\bmutations\b|\bactions\b|\bgetters\b|\bnamespaced\b"
);

// value-ref target-name distinctiveness: /[A-Z_]/
re!(has_upper_or_underscore, r"[A-Z_]");

/// isGeneratedFile (src/extraction/generated-detection.ts) — full pattern list
/// ported so future language walkers share it.
pub fn is_generated_file(file_path: &str) -> bool {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = RES.get_or_init(|| {
        [
            r"\.pb\.go$",
            r"\.pulsar\.go$",
            r"_grpc\.pb\.go$",
            r"_mock\.go$",
            r"_mocks\.go$",
            r"^mock_[^/]+\.go$",
            r"\.generated\.[jt]sx?$",
            r"\.gen\.[jt]sx?$",
            r"\.pb\.[jt]s$",
            r"_pb\.[jt]s$",
            r"_grpc_pb\.[jt]s$",
            r"\.min\.m?js$",
            r"_pb2(_grpc)?\.py$",
            r"_pb2\.pyi$",
            r"\.pb\.(cc|h)$",
            r"\.g\.cs$",
            r"Grpc\.cs$",
            r"OuterClass\.java$",
            r"Grpc\.java$",
            r"\.pb\.swift$",
            r"\.g\.dart$",
            r"\.freezed\.dart$",
            r"\.pb\.dart$",
            r"\.pbgrpc\.dart$",
            r"\.chopper\.dart$",
            r"\.generated\.rs$",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("generated pattern"))
        .collect()
    });
    patterns.iter().any(|p| p.is_match(file_path))
}

/// Byte offsets of each line start, for UTF-16 column conversion.
pub fn line_starts(src: &str) -> Vec<usize> {
    let mut out = vec![0usize];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            out.push(i + 1);
        }
    }
    out
}

/// UTF-16 code units in `s` — what web-tree-sitter (and JS string ops)
/// count, so kernel-emitted columns are byte-identical to the wasm path's.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// Column (UTF-16 units) of `byte_pos` on line `row`, given `line_starts`.
pub fn col16(src: &str, starts: &[usize], row: usize, byte_pos: usize) -> u32 {
    let ls = starts.get(row).copied().unwrap_or(0);
    if byte_pos <= ls {
        return 0;
    }
    utf16_len(&src[ls..byte_pos]) as u32
}

pub fn node_line(node: Node) -> u32 {
    node.start_position().row as u32 + 1
}

pub fn node_column(src: &str, starts: &[usize], node: Node) -> u32 {
    col16(src, starts, node.start_position().row, node.start_byte())
}

pub fn node_end_column(src: &str, starts: &[usize], node: Node) -> u32 {
    col16(src, starts, node.end_position().row, node.end_byte())
}

pub fn source_text<'a>(src: &'a str, node: Node) -> &'a str {
    &src[node.byte_range()]
}

pub fn trimmed_non_empty_node_text(src: &str, node: Node) -> Option<String> {
    let text = source_text(src, node).trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// JS `String.prototype.slice(0, n)` in UTF-16 units, without splitting a
/// surrogate pair (when the cut would split one, we stop one code unit short —
/// a lone surrogate isn't representable in Rust and never round-trips through
/// SQLite anyway). Returns (sliced, was_truncated_at_or_beyond_n).
pub fn slice_utf16(s: &str, n: usize) -> (String, bool) {
    let mut used = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            return (out, true);
        }
        used += w;
        out.push(c);
        if used == n {
            // Exactly at the limit: truncated iff any source remains.
            let truncated = out.len() < s.len();
            return (out, truncated);
        }
    }
    (out, false)
}

/// objectKeyName (tree-sitter.ts): strip ONE leading and ONE trailing quote
/// character (`'`, `"`, or backtick).
pub fn object_key_name(s: &str) -> String {
    let mut out = s;
    if let Some(first) = out.chars().next() {
        if first == '\'' || first == '"' || first == '`' {
            out = &out[first.len_utf8()..];
        }
    }
    if let Some(last) = out.chars().last() {
        if last == '\'' || last == '"' || last == '`' {
            out = &out[..out.len() - last.len_utf8()];
        }
    }
    out.to_string()
}

/// The `= <first 100 UTF-16 units>[...]` initializer signature used by
/// extractVariable (its `.length >= 100` check fires exactly when the slice
/// hit the cap).
pub fn init_signature(value_text: &str) -> String {
    let (sliced, _) = slice_utf16(value_text, 100);
    if utf16_len(&sliced) >= 100 {
        format!("= {sliced}...")
    } else {
        format!("= {sliced}")
    }
}

/// Return the terminal type/member name from a dotted or `::`-qualified name.
pub fn terminal_path_name(name: &str) -> String {
    let cut = name
        .rfind('.')
        .map(|index| index as isize)
        .unwrap_or(-1)
        .max(name.rfind("::").map(|index| index as isize).unwrap_or(-1));
    if cut < 0 {
        return name.to_string();
    }
    let mut terminal = name[(cut as usize + 1)..].to_string();
    if terminal.starts_with(':') || terminal.starts_with('.') {
        terminal.remove(0);
    }
    terminal
}

/// C-family constructor names: discard the first non-nested generic suffix,
/// then keep the terminal dotted/`::`-qualified segment.
pub fn strip_generic_and_qualifier(raw: &str) -> String {
    let mut name = raw.to_string();
    if let Some(lt) = name.find('<') {
        if lt > 0 {
            name.truncate(lt);
        }
    }
    terminal_path_name(name.trim()).trim().to_string()
}

pub fn normalize_parenthesized_name(name: &str) -> String {
    paren_conversion()
        .captures(name)
        .map(|capture| capture[1].to_string())
        .unwrap_or_else(|| name.to_string())
}

pub fn compose_member_callee(receiver: Option<&str>, method: &str) -> String {
    match receiver {
        Some(receiver) if !matches!(receiver, "self" | "this" | "cls" | "super") => {
            format!("{receiver}.{method}")
        }
        _ => method.to_string(),
    }
}

/// Check the c-family parameter-storage shape (`lhs = rhs` where the last
/// identifier on the lhs is exactly the rhs text).
pub fn is_param_storage_assignment(lhs_text: &str, rhs_text: &str) -> bool {
    lhs_last_name()
        .captures(lhs_text)
        .and_then(|capture| capture.get(1))
        .map(|match_| match_.as_str())
        == Some(rhs_text.trim())
}

pub fn is_param_storage_assignment_node(node: Node, source: &str, rhs: Node) -> bool {
    let lhs = node
        .child_by_field_name("left")
        .map(|left| source_text(source, left))
        .unwrap_or("");
    is_param_storage_assignment(lhs, source_text(source, rhs))
}

pub fn named_identifier_texts(node: Node, source: &str) -> Vec<String> {
    named_children(node)
        .filter(|child| matches!(child.kind(), "identifier" | "simple_identifier"))
        .map(|child| source_text(source, child).to_string())
        .collect()
}
