//! fields support for cfnptr.

use super::*;

// ---------- struct field parsing ----------

/// splitTopLevel(body, sep): split on `sep` at brace/paren/bracket depth 0.
pub(super) fn split_top_level(body: &[u8], sep: u8) -> Vec<Range> {
    let mut out = Vec::new();
    let mut depth = 0i64;
    let mut start = 0usize;
    for (i, &c) in body.iter().enumerate() {
        match c {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' => depth -= 1,
            _ if c == sep && depth == 0 => {
                out.push((start, i));
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push((start, body.len()));
    out
}

/// JS String.prototype.trim over bytes (the JS set == our jsws set).
pub(super) fn jsws_trim(s: &[u8], mut a: usize, mut b: usize) -> (usize, usize) {
    loop {
        let l = jsws_len(s, a);
        if l == 0 || a + l > b {
            break;
        }
        a += l;
    }
    // Trailing: walk from the front to find the last non-ws position (ws
    // lengths vary, so scan forward tracking the end of the last non-ws char).
    let mut i = a;
    let mut last_end = a;
    while i < b {
        let l = jsws_len(s, i);
        if l == 0 {
            i += 1;
            last_end = i;
        } else {
            i += l;
        }
    }
    b = last_end;
    (a, b)
}

/// /(\w+)\s+\**\s*(\w+)\s*$/ — leftmost match whose tail reaches the end.
/// Deterministic per start (greedy words/ws cannot backtrack usefully);
/// candidate starts advance one byte at a time like the JS engine.
pub(super) fn first_typed(part: &[u8]) -> Option<(Range, Range)> {
    let n = part.len();
    let mut p = 0usize;
    while p < n {
        if !is_word(part[p]) {
            p += 1;
            continue;
        }
        let te = word_end(part, p);
        let w = skip_jsws(part, te);
        if w == te {
            p += 1;
            continue;
        }
        let mut q = w;
        while q < n && part[q] == b'*' {
            q += 1;
        }
        let q = skip_jsws(part, q);
        if is_word_at(part, q) {
            let ne = word_end(part, q);
            let t = skip_jsws(part, ne);
            if t == n {
                return Some(((p, te), (q, ne)));
            }
        }
        p += 1;
    }
    None
}

/// FNPTR_DECL_RE (first match): /\(\s*(?:\w+\s+)*\*\s*(\w+)\s*\)\s*\(/
pub(super) fn fnptr_decl(part: &[u8]) -> Option<Range> {
    let mut i = 0usize;
    while i < part.len() {
        if part[i] == b'(' {
            if let Some((name, _)) = fnptr_paren_tail(part, i) {
                return Some(name);
            }
        }
        i += 1;
    }
    None
}

/// Port of `parseStructFieldsRaw` — structure only, classification TS-side.
pub fn parse_struct_fields_raw(inner: &[u8]) -> Vec<RawField> {
    let mut fields = Vec::new();
    let mut idx: u32 = 0;
    for (ds, de) in split_top_level(inner, b';') {
        let (ds, de) = jsws_trim(inner, ds, de);
        if ds >= de {
            continue;
        }
        let decl = &inner[ds..de];
        let parts = split_top_level(decl, b',');
        let ft = first_typed(&decl[parts[0].0..parts[0].1]);
        let shared_type: &[u8] = match &ft {
            Some(((ts, te), _)) => &decl[parts[0].0 + ts..parts[0].0 + te],
            None => b"",
        };
        for (pi, &(ps, pe)) in parts.iter().enumerate() {
            let (ps2, pe2) = jsws_trim(decl, ps, pe);
            let p = &decl[ps2..pe2];
            let mut name: &[u8] = b"";
            let mut ty: &[u8] = b"";
            let mut ptr = false;
            if let Some((ns, ne)) = fnptr_decl(p) {
                name = &p[ns..ne];
                ptr = true;
            } else if pi == 0 {
                if let Some((_, (ns, ne))) = &ft {
                    name = &decl[parts[0].0 + ns..parts[0].0 + ne];
                    ty = shared_type;
                }
            } else {
                // /^\**\s*(\w+)/
                let mut q = 0usize;
                while q < p.len() && p[q] == b'*' {
                    q += 1;
                }
                let q = skip_jsws(p, q);
                if is_word_at(p, q) {
                    name = &p[q..word_end(p, q)];
                    ty = shared_type;
                }
            }
            fields.push(RawField {
                name: bytes_to_string(name),
                index: idx,
                ptr,
                ty: bytes_to_string(ty),
            });
            idx += 1;
        }
    }
    fields
}
