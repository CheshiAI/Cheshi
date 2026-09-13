//! declarations support for cfnptr.

use super::*;

// ---------- scanners ----------

/// FNPTR_TYPEDEF_RE: /\btypedef\b[^;{}]*?\(\s*(?:\w+\s+)*\*\s*(\w+)\s*\)\s*\(/g
pub(super) fn scan_fnptr_typedefs(s: &[u8], out: &mut Vec<String>) {
    let mut last = 0;
    while let Some(t) = find_word(s, b"typedef", last) {
        let mut j = t + 7;
        let mut matched = None;
        // Lazy [^;{}]*?: try the paren tail at each `(` in order; the class
        // may also expand ACROSS a failed `(` (it admits parens).
        while j < s.len() {
            let ch = s[j];
            if ch == b';' || ch == b'{' || ch == b'}' {
                break;
            }
            if ch == b'(' {
                if let Some((name, end)) = fnptr_paren_tail(s, j) {
                    matched = Some((name, end));
                    break;
                }
            }
            j += 1;
        }
        match matched {
            Some(((ns, ne), end)) => {
                push_str(out, &s[ns..ne]);
                last = end;
            }
            None => last = t + 1,
        }
    }
}

/// FNTYPE_TYPEDEF_STMT_RE (/\btypedef\b([^;{}]*);/g) + the TS-side guts
/// checks: skip when guts contains `(*` or `( *`; else the FIRST
/// /\b(\w+)\s*\(/ capture, filtered through C_TYPE_KEYWORDS.
pub(super) fn scan_fntype_typedefs(s: &[u8], out: &mut Vec<String>) {
    let mut last = 0;
    while let Some(t) = find_word(s, b"typedef", last) {
        let mut j = t + 7;
        while j < s.len() && s[j] != b';' && s[j] != b'{' && s[j] != b'}' {
            j += 1;
        }
        if j >= s.len() || s[j] != b';' {
            last = t + 1;
            continue;
        }
        let guts = &s[t + 7..j];
        if !contains_bytes(guts, b"(*") && !contains_bytes(guts, b"( *") {
            // first \b(\w+)\s*\( in guts
            let mut p = 0;
            while p < guts.len() {
                if is_word(guts[p]) && boundary_before(guts, p) {
                    let we = word_end(guts, p);
                    let k = skip_jsws(guts, we);
                    if guts.get(k) == Some(&b'(') {
                        let w = &guts[p..we];
                        if !is_type_keyword(w) {
                            push_str(out, w);
                        }
                        break;
                    }
                    p = we;
                } else {
                    p += 1;
                }
            }
        }
        last = j + 1;
    }
}

/// INLINE_STRUCT_RE (/\bstruct\s+(\w+)\s*\{/g), sweep flavor: NO cursor jump
/// (the filter needs a superset of the registration pass's jump-scan), each
/// valid candidate (balanced braces + the `^\s*(\w+)…` var check) contributes
/// its tag and a structural field summary.
pub(super) struct InlineScan {
    pub(super) ptr: bool,
    pub(super) types: Vec<String>,
    pub(super) tags: Vec<String>,
}

pub(super) fn scan_inline_structs(s: &[u8]) -> InlineScan {
    let mut out = InlineScan {
        ptr: false,
        types: Vec::new(),
        tags: Vec::new(),
    };
    let mut last = 0;
    while let Some(t) = find_word(s, b"struct", last) {
        let after_kw = t + 6;
        let ws = skip_jsws(s, after_kw);
        if ws == after_kw || !is_word_at(s, ws) {
            last = t + 1;
            continue;
        }
        let te = word_end(s, ws);
        let open = skip_jsws(s, te);
        if s.get(open) != Some(&b'{') {
            last = t + 1;
            continue;
        }
        last = open + 1; // lastIndex = end of match (after `{`)
        let Some(close) = match_brace(s, open) else {
            continue;
        };
        // vm: /^\s*(\w+)…/ on the text after `}` — only vm[1] matters here.
        let v = skip_jsws(s, close + 1);
        if !is_word_at(s, v) {
            continue;
        }
        push_str(&mut out.tags, &s[ws..te]);
        for f in parse_struct_fields_raw(&s[open + 1..close]) {
            if f.name.is_empty() {
                continue;
            }
            if f.ptr {
                out.ptr = true;
            } else if !f.ty.is_empty() {
                out.types.push(f.ty);
            }
        }
    }
    out
}

/// matchBrace: index of the `}` matching the `{` at `open`, or None.
pub(super) fn match_brace(s: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i64;
    let mut i = open;
    while i < s.len() {
        match s[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The `(?:(?:static|const|extern|register|volatile)\s+)*` modifier loop:
/// greedy positions after 0..=k iterations, for the k-descending backtrack the
/// INIT/ARRAY skeletons need. No two alternatives share a prefix, so at most
/// one literal can match at a position; an alternative that matches without
/// trailing `\s+` ends the loop (JS: iteration fails, no other alt can fire).
pub(super) fn modifier_positions(s: &[u8], start: usize) -> Vec<usize> {
    let mut stack = vec![start];
    loop {
        let cur = *stack.last().unwrap();
        let mut advanced = None;
        for m in MODIFIERS {
            if s.len() >= cur + m.len() && &s[cur..cur + m.len()] == m {
                let e = cur + m.len();
                let w = skip_jsws(s, e);
                if w > e {
                    advanced = Some(w);
                }
                break; // exactly one alternative can literal-match here
            }
        }
        match advanced {
            Some(w) => stack.push(w),
            None => return stack,
        }
    }
}

/// `\[[^\]]*\]` at `i` (the INIT/ARRAY declarator form — the class admits
/// newlines): position after the FIRST `]`, or None.
pub(super) fn bracket_span(s: &[u8], i: usize) -> Option<usize> {
    if s.get(i) != Some(&b'[') {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && s[j] != b']' {
        j += 1;
    }
    if j < s.len() {
        Some(j + 1)
    } else {
        None
    }
}

/// Anchor-skeleton driver shared by INIT_RE and ARRAY_TABLE_RE: both match
/// `(?:^|[;{}])` then a body, and resume from the end of each match. `body`
/// returns (token, match_end) when the body matches at the position after the
/// anchor.
pub(super) fn scan_anchored<F>(s: &[u8], mut body: F, out: &mut Vec<String>)
where
    F: FnMut(&[u8], usize) -> Option<(String, usize)>,
{
    let mut last = 0usize;
    // The `^` branch consumes nothing and only exists at position 0.
    if last == 0 {
        if let Some((tok, end)) = body(s, 0) {
            out.push(tok);
            last = end;
        }
    }
    let mut p = last;
    while p < s.len() {
        let ch = s[p];
        if ch == b';' || ch == b'{' || ch == b'}' {
            if let Some((tok, end)) = body(s, p + 1) {
                out.push(tok);
                p = end;
                continue;
            }
        }
        p += 1;
    }
}

/// INIT_RE body after the anchor:
/// `\s*(?:MOD\s+)*(?:struct\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*=\s*\{`
/// Backtracks: modifier count (desc), `struct` with/without, bracket
/// with/without — exactly the observable dimensions of the JS engine.
pub(super) fn init_body(s: &[u8], p: usize) -> Option<(String, usize)> {
    let i = skip_jsws(s, p);
    let mods = modifier_positions(s, i);
    for &pos in mods.iter().rev() {
        for with_struct in [true, false] {
            let q = if with_struct {
                if s.len() >= pos + 6 && &s[pos..pos + 6] == b"struct" {
                    let e = pos + 6;
                    let w = skip_jsws(s, e);
                    if w == e {
                        continue;
                    }
                    w
                } else {
                    continue;
                }
            } else {
                pos
            };
            if !is_word_at(s, q) {
                continue;
            }
            let te = word_end(s, q);
            let w = skip_jsws(s, te);
            if w == te {
                continue; // \s+ needs ≥1
            }
            if !is_word_at(s, w) {
                continue;
            }
            let ne = word_end(s, w);
            let r = skip_jsws(s, ne);
            for with_bracket in [true, false] {
                let r2 = if with_bracket {
                    match bracket_span(s, r) {
                        Some(e) => e,
                        None => continue,
                    }
                } else {
                    r
                };
                let r3 = skip_jsws(s, r2);
                if s.get(r3) != Some(&b'=') {
                    continue;
                }
                let r4 = skip_jsws(s, r3 + 1);
                if s.get(r4) != Some(&b'{') {
                    continue;
                }
                return Some((bytes_to_string(&s[q..te]), r4 + 1));
            }
        }
    }
    None
}

/// ARRAY_TABLE_RE body after the anchor:
/// `\s*(?:MOD\s+)*(\w+)\s+(\*\s*)?(\w+)\s*\[[^\]]*\]\s*=\s*\{`
/// Token is `*`-prefixed when the star declarator is present.
pub(super) fn array_table_body(s: &[u8], p: usize) -> Option<(String, usize)> {
    let i = skip_jsws(s, p);
    let mods = modifier_positions(s, i);
    for &pos in mods.iter().rev() {
        if !is_word_at(s, pos) {
            continue;
        }
        let te = word_end(s, pos);
        let w = skip_jsws(s, te);
        if w == te {
            continue;
        }
        for with_star in [true, false] {
            let q = if with_star {
                if s.get(w) == Some(&b'*') {
                    skip_jsws(s, w + 1)
                } else {
                    continue;
                }
            } else {
                w
            };
            if !is_word_at(s, q) {
                continue;
            }
            let ne = word_end(s, q);
            let r = skip_jsws(s, ne);
            let Some(r2) = bracket_span(s, r) else {
                continue;
            };
            let r3 = skip_jsws(s, r2);
            if s.get(r3) != Some(&b'=') {
                continue;
            }
            let r4 = skip_jsws(s, r3 + 1);
            if s.get(r4) != Some(&b'{') {
                continue;
            }
            let mut tok = String::new();
            if with_star {
                tok.push('*');
            }
            tok.push_str(&bytes_to_string(&s[pos..te]));
            return Some((tok, r4 + 1));
        }
    }
    None
}

/// OBJ_ALIAS_RE over the continuation-joined text:
/// /^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(?:struct[ \t]+)*[A-Za-z_]\w*[ \t\r]*$/gm
pub(super) fn scan_alias_names(stripped: &[u8], out: &mut Vec<String>) {
    // joined = stripped.replace(/\\\r?\n/g, ' ')
    let mut joined = Vec::with_capacity(stripped.len());
    let mut i = 0;
    while i < stripped.len() {
        let b = stripped[i];
        if b == b'\\' {
            if stripped.get(i + 1) == Some(&b'\n') {
                joined.push(b' ');
                i += 2;
                continue;
            }
            if stripped.get(i + 1) == Some(&b'\r') && stripped.get(i + 2) == Some(&b'\n') {
                joined.push(b' ');
                i += 3;
                continue;
            }
        }
        joined.push(b);
        i += 1;
    }
    for line in joined.split(|&b| b == b'\n') {
        if let Some(name) = alias_line(line) {
            push_str(out, name);
        }
    }
}

#[inline]
pub(super) fn skip_sp_tab(line: &[u8], mut i: usize) -> usize {
    while i < line.len() && (line[i] == b' ' || line[i] == b'\t') {
        i += 1;
    }
    i
}

pub(super) fn alias_line(line: &[u8]) -> Option<&[u8]> {
    let mut i = skip_sp_tab(line, 0);
    if line.get(i) != Some(&b'#') {
        return None;
    }
    i = skip_sp_tab(line, i + 1);
    if line.len() < i + 6 || &line[i..i + 6] != b"define" {
        return None;
    }
    i += 6;
    let w = skip_sp_tab(line, i);
    if w == i || !is_word_at(line, w) {
        return None;
    }
    let name_end = word_end(line, w);
    let name = &line[w..name_end];
    let v0 = skip_sp_tab(line, name_end);
    if v0 == name_end {
        return None; // [ \t]+ before the value
    }
    // (?:struct[ \t]+)* greedy, k-descending on value failure.
    let mut stack = vec![v0];
    loop {
        let cur = *stack.last().unwrap();
        if line.len() >= cur + 6 && &line[cur..cur + 6] == b"struct" {
            let e = cur + 6;
            let w2 = skip_sp_tab(line, e);
            if w2 > e {
                stack.push(w2);
                continue;
            }
        }
        break;
    }
    for &vp in stack.iter().rev() {
        let Some(&b0) = line.get(vp) else { continue };
        if !(b0.is_ascii_alphabetic() || b0 == b'_') {
            continue; // value must start [A-Za-z_]
        }
        let ve = word_end(line, vp);
        // [ \t\r]*$
        let mut t = ve;
        while t < line.len() && (line[t] == b' ' || line[t] == b'\t' || line[t] == b'\r') {
            t += 1;
        }
        if t == line.len() {
            return Some(name);
        }
    }
    None
}

/// INCLUDE_RE over RAW text: /#[ \t]*include[ \t]+"([^"\n]+)"/g
pub(super) fn scan_includes(raw: &[u8], out: &mut Vec<String>) {
    let mut pos = 0usize;
    while pos < raw.len() {
        let Some(h) = find_bytes(raw, b"#", pos) else {
            break;
        };
        let mut i = skip_sp_tab(raw, h + 1);
        if raw.len() < i + 7 || &raw[i..i + 7] != b"include" {
            pos = h + 1;
            continue;
        }
        i += 7;
        let q = skip_sp_tab(raw, i);
        if q == i || raw.get(q) != Some(&b'"') {
            pos = h + 1;
            continue;
        }
        let mut j = q + 1;
        while j < raw.len() && raw[j] != b'"' && raw[j] != b'\n' {
            j += 1;
        }
        if j > q + 1 && j < raw.len() && raw[j] == b'"' {
            out.push(bytes_to_string(&raw[q + 1..j]));
            pos = j + 1;
        } else {
            pos = h + 1;
        }
    }
}
