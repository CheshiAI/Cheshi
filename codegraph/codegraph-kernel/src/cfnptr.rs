//! Native port of the cFnPtr synthesizer's EXTRACTION SWEEP (task #5 step 2,
//! plan §7a.9): raw file text in → collected per-file facts out. The linking
//! stages, gates, and every registration/dispatch decision stay TS-side; this
//! module only reproduces, bug-for-bug, what the JS sweep computes per file in
//! `src/resolution/c-fnptr-synthesizer.ts`:
//!
//!   • `stripCommentsForRegex(text, 'c')` — the C-style comment/string state
//!     machine (comments blanked to spaces, string interiors skipped, backtick
//!     treated as a multi-line string delimiter — quirks and all);
//!   • the typedef scans (fn-pointer + fn-type forms);
//!   • struct-node field declarations (structural parse; classification stays
//!     TS-side where the complete typedef sets live);
//!   • the survival-filter scans (inline structs, initializers, bare arrays,
//!     alias-shaped object macros, field-assign pairs, dispatch fields, array
//!     dispatch names);
//!   • the raw-text `#include "..."` capture (path resolution stays TS-side —
//!     it needs the filesystem).
//!
//! Parity discipline: the JS side runs these as JavaScript REGEXES, so every
//! scanner here is a hand-rolled byte machine replicating THAT engine's
//! semantics, not idiomatic Rust regex:
//!   • JS `\w`/`\b` are ASCII (non-ASCII chars are non-word) — byte checks
//!     against `[A-Za-z0-9_]` reproduce them exactly, because UTF-8
//!     continuation bytes are non-ASCII and therefore non-word on both sides.
//!   • JS `\s` is the UNICODE whitespace class (NBSP, U+2000-200A, U+FEFF, …)
//!     — `jsws_len` decodes exactly that set from UTF-8.
//!   • Backtracking is reproduced where it is observable (INIT/ARRAY modifier
//!     and `struct` keyword ambiguity, DISPATCH's greedy segment loop,
//!     optional groups) and elided only where analysis shows no input can
//!     distinguish greedy from backtracked (documented per scanner).
//!   • `lastIndex` advancement (resume after each match, +1 on failure) is
//!     reproduced so overlapping-match selection is identical.
//!
//! The stripper blanks per UTF-16 code unit (see `strip_c`), so its output
//! equals the JS stripper's output EXACTLY as a string — every scanner here
//! runs over the identical character stream the JS regexes see, and the strip
//! differential oracle test pins that equality directly. The record-level
//! differential suite (JS sweep vs this sweep over fixtures and whole repos)
//! then pins the scanners themselves.

/// One struct node's extent, as the TS side reads it from the graph.
pub struct StructExtent {
    pub id: String,
    pub start_line: u32,
    pub end_line: u32,
}

/// A structurally-parsed struct field — mirror of the TS `RawFieldDecl`
/// (`name: null` is represented as an empty string; the TS side treats them
/// identically everywhere).
pub struct RawField {
    pub name: String,
    pub index: u32,
    pub ptr: bool,
    pub ty: String,
}

pub struct StructFields {
    pub id: String,
    /// False when the body never parsed (no `{`, unbalanced braces, or a
    /// falsy start line) — the TS side then records nothing for this node,
    /// exactly like the JS sweep.
    pub parsed: bool,
    pub fields: Vec<RawField>,
}

/// Everything the sweep collects for one file.
pub struct FileFacts {
    pub fn_ptr_typedefs: Vec<String>,
    pub fn_type_typedefs: Vec<String>,
    pub structs: Vec<StructFields>,
    pub inline_ptr: bool,
    pub inline_types: Vec<String>,
    pub inline_tags: Vec<String>,
    pub init_tokens: Vec<String>,
    /// `*`-prefixed when the declaration carried the pointer star.
    pub array_elems: Vec<String>,
    pub alias_names: Vec<String>,
    /// `lfield\0rfield`, distinct.
    pub d_pairs: Vec<String>,
    pub dispatch_fields: Vec<String>,
    pub array_dispatch_names: Vec<String>,
    /// Raw `#include "…"` captures, in source order, NOT deduplicated —
    /// extension filtering and path resolution happen TS-side.
    pub includes: Vec<String>,
}

/// Mirror of the TS `C_TYPE_KEYWORDS` set — keep in exact sync.
const C_TYPE_KEYWORDS: [&[u8]; 17] = [
    b"void",
    b"int",
    b"char",
    b"short",
    b"long",
    b"unsigned",
    b"signed",
    b"float",
    b"double",
    b"const",
    b"struct",
    b"union",
    b"enum",
    b"static",
    b"volatile",
    b"register",
    b"inline",
];

fn is_type_keyword(w: &[u8]) -> bool {
    C_TYPE_KEYWORDS.contains(&w)
}

const MODIFIERS: [&[u8]; 5] = [b"static", b"const", b"extern", b"register", b"volatile"];

/// Run the full extraction sweep for one file. `raw` is the file text exactly
/// as the TS side read it; `structs` are the file's struct-node extents.
pub fn scan_file(raw: &str, structs: &[StructExtent]) -> FileFacts {
    let raw_b = raw.as_bytes();
    let stripped = strip_c(raw_b);
    let s: &[u8] = &stripped;

    let mut facts = FileFacts {
        fn_ptr_typedefs: Vec::new(),
        fn_type_typedefs: Vec::new(),
        structs: Vec::new(),
        inline_ptr: false,
        inline_types: Vec::new(),
        inline_tags: Vec::new(),
        init_tokens: Vec::new(),
        array_elems: Vec::new(),
        alias_names: Vec::new(),
        d_pairs: Vec::new(),
        dispatch_fields: Vec::new(),
        array_dispatch_names: Vec::new(),
        includes: Vec::new(),
    };

    // Typedefs (gated like the JS sweep — purely a fast path, the scans find
    // nothing without the substring anyway).
    if contains_bytes(s, b"typedef") {
        scan_fnptr_typedefs(s, &mut facts.fn_ptr_typedefs);
        scan_fntype_typedefs(s, &mut facts.fn_type_typedefs);
    }

    // Struct-node field declarations.
    if !structs.is_empty() {
        let lines = line_starts(s);
        for st in structs {
            let mut sf = StructFields {
                id: st.id.clone(),
                parsed: false,
                fields: Vec::new(),
            };
            // sliceLinesPre: falsy startLine → '' (never parses). end_line
            // arrives with the TS side's `?? startLine` already applied; a
            // slice whose end ≤ start is empty, exactly like Array.slice.
            if st.start_line >= 1 {
                let a = (st.start_line - 1) as usize;
                let b = st.end_line as usize;
                if a < lines.len() && b > a {
                    let body_start = lines[a];
                    // End of line (b-1): next line start minus the `\n`, or EOF.
                    let body_end = if b < lines.len() {
                        lines[b] - 1
                    } else {
                        s.len()
                    };
                    let body = &s[body_start..body_end.max(body_start)];
                    if let Some(open) = body.iter().position(|&c| c == b'{') {
                        if let Some(close) = match_brace(body, open) {
                            sf.parsed = true;
                            sf.fields = parse_struct_fields_raw(&body[open + 1..close]);
                        }
                    }
                }
            }
            facts.structs.push(sf);
        }
    }

    // Registration filters.
    if contains_bytes(s, b"{") {
        let inline = scan_inline_structs(s);
        facts.inline_ptr = inline.ptr;
        facts.inline_types = dedup_in_order(inline.types);
        facts.inline_tags = dedup_in_order(inline.tags);
        if contains_bytes(s, b"=") {
            scan_anchored(s, init_body, &mut facts.init_tokens);
            facts.init_tokens = dedup_in_order(std::mem::take(&mut facts.init_tokens));
            scan_anchored(s, array_table_body, &mut facts.array_elems);
            facts.array_elems = dedup_in_order(std::mem::take(&mut facts.array_elems));
        }
    }

    // Alias-shaped object macros.
    if contains_bytes(s, b"#define") || contains_bytes(s, b"# define") {
        scan_alias_names(s, &mut facts.alias_names);
        facts.alias_names = dedup_in_order(std::mem::take(&mut facts.alias_names));
    }

    // Propagation + dispatch filters.
    if contains_bytes(s, b"=") {
        scan_field_assign(s, &mut facts.d_pairs);
        facts.d_pairs = dedup_in_order(std::mem::take(&mut facts.d_pairs));
    }
    scan_dispatch(s, &mut facts.dispatch_fields);
    facts.dispatch_fields = dedup_in_order(std::mem::take(&mut facts.dispatch_fields));
    scan_array_dispatch(s, &mut facts.array_dispatch_names);
    facts.array_dispatch_names = dedup_in_order(std::mem::take(&mut facts.array_dispatch_names));

    // Includes come from the RAW text (string contents survive there).
    if contains_bytes(raw_b, b"include") {
        scan_includes(raw_b, &mut facts.includes);
    }

    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(src: &str) -> FileFacts {
        scan_file(src, &[])
    }

    #[test]
    fn strip_blanks_comments_keeps_strings() {
        let s = strip_c(b"a /* x\ny */ b // c\nd \"in//str\" e");
        assert_eq!(&s, b"a     \n     b     \nd \"in//str\" e".as_slice());
    }

    #[test]
    fn typedef_forms() {
        let f = facts("typedef void (*hook_fn)(int);\ntypedef void redisCommandProc(int c);\n");
        assert_eq!(f.fn_ptr_typedefs, vec!["hook_fn"]);
        assert_eq!(f.fn_type_typedefs, vec!["redisCommandProc"]);
    }

    #[test]
    fn init_modifier_backtrack() {
        // `static x = {` must match with type token `static` (the JS engine
        // backtracks the modifier loop) — harmless downstream, but collected.
        let f = facts("; static x = {1};\n; static struct cmd t[] = { {0} };");
        assert!(f.init_tokens.contains(&"static".to_string()));
        assert!(f.init_tokens.contains(&"cmd".to_string()));
    }

    #[test]
    fn dispatch_backtracks_segments() {
        let f = facts("int go(struct c *x){ x->cmd->proc(1); tbl[i](2); (*ops[k])(3); }");
        assert!(f.dispatch_fields.contains(&"proc".to_string()));
        assert!(f.array_dispatch_names.contains(&"tbl".to_string()));
        assert!(f.array_dispatch_names.contains(&"ops".to_string()));
    }

    #[test]
    fn field_assign_pairs() {
        let f = facts("void g(void){ a->f = b->g; h.x = k.y; m == n; }");
        assert!(f.d_pairs.contains(&"f\0g".to_string()));
        assert!(f.d_pairs.contains(&"x\0y".to_string()));
        assert_eq!(f.d_pairs.len(), 2);
    }

    #[test]
    fn alias_shapes() {
        let f =
            facts("#define A redisCommand\n#define B struct foo\n#define C 0x12\n#define D(x) x\n");
        assert!(f.alias_names.contains(&"A".to_string()));
        assert!(f.alias_names.contains(&"B".to_string()));
        assert!(!f.alias_names.contains(&"C".to_string()));
        assert!(!f.alias_names.contains(&"D".to_string()));
    }

    #[test]
    fn includes_from_raw() {
        let f = facts("#include \"commands.def\"\n// #include \"in-comment.h\"\n");
        // Raw-text scan: the commented include IS captured (parity with the
        // JS INCLUDE_RE over raw text).
        assert_eq!(f.includes, vec!["commands.def", "in-comment.h"]);
    }
}

mod lexical;
use lexical::*;
mod declarations;
use declarations::*;
mod dispatch;
use dispatch::*;
mod fields;
pub use fields::parse_struct_fields_raw;
pub use lexical::strip_c;
