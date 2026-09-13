//! dispatch support for cfnptr.

use super::*;

/// FIELD_ASSIGN_RE: /(\w+)\s*(?:->|\.)\s*(\w+)\s*=\s*(\w+)\s*(?:->|\.)\s*(\w+)/g
/// Pairs collected as `lfield\0rfield`. Every byte position is a candidate
/// start (JS advances one unit on failure — suffix starts included); matches
/// resume at their end.
pub(super) fn scan_field_assign(s: &[u8], out: &mut Vec<String>) {
    let mut pos = 0usize;
    while pos < s.len() {
        if !is_word(s[pos]) {
            pos += 1;
            continue;
        }
        match field_assign_at(s, pos) {
            Some((lf, rf, end)) => {
                let mut pair = bytes_to_string(&s[lf.0..lf.1]);
                pair.push('\0');
                pair.push_str(&bytes_to_string(&s[rf.0..rf.1]));
                out.push(pair);
                pos = end;
            }
            None => pos += 1,
        }
    }
}

#[inline]
pub(super) fn arrow_at(s: &[u8], i: usize) -> Option<usize> {
    if s.get(i) == Some(&b'-') && s.get(i + 1) == Some(&b'>') {
        Some(i + 2)
    } else if s.get(i) == Some(&b'.') {
        Some(i + 1)
    } else {
        None
    }
}

pub(super) type Range = (usize, usize);

pub(super) fn field_assign_at(s: &[u8], p: usize) -> Option<(Range, Range, usize)> {
    let w1 = word_end(s, p);
    let a1 = arrow_at(s, skip_jsws(s, w1))?;
    let f1s = skip_jsws(s, a1);
    if !is_word_at(s, f1s) {
        return None;
    }
    let f1e = word_end(s, f1s);
    let eq = skip_jsws(s, f1e);
    if s.get(eq) != Some(&b'=') {
        return None;
    }
    let r1s = skip_jsws(s, eq + 1);
    if !is_word_at(s, r1s) {
        return None;
    }
    let r1e = word_end(s, r1s);
    let a2 = arrow_at(s, skip_jsws(s, r1e))?;
    let f2s = skip_jsws(s, a2);
    if !is_word_at(s, f2s) {
        return None;
    }
    let f2e = word_end(s, f2s);
    Some(((f1s, f1e), (f2s, f2e), f2e))
}

/// DISPATCH_RE: /((?:\w+(?:\s*\[[^\][]*\])?\s*(?:->|\.)\s*)+)(\w+)\s*\)?\s*\(/g
/// The `+` loop is consumed greedily, then the field tail is tried at each
/// segment count k descending — the JS engine's observable backtracking. The
/// per-segment optional subscript needs no cross-product: the with/without
/// parses diverge at the arrow and at most one can complete a segment.
pub(super) fn scan_dispatch(s: &[u8], out: &mut Vec<String>) {
    let mut pos = 0usize;
    while pos < s.len() {
        if !is_word(s[pos]) {
            pos += 1;
            continue;
        }
        // Greedy segment loop.
        let mut seg_ends: Vec<usize> = Vec::new();
        let mut cur = pos;
        while is_word_at(s, cur) {
            let we = word_end(s, cur);
            let with_sub = subscript_span(s, skip_jsws(s, we)).and_then(|e| arrow_tail(s, e));
            let seg = with_sub.or_else(|| arrow_tail(s, we));
            match seg {
                Some(e) => {
                    seg_ends.push(e);
                    cur = e;
                }
                None => break,
            }
        }
        let mut matched = None;
        for k in (1..=seg_ends.len()).rev() {
            let fpos = seg_ends[k - 1];
            if !is_word_at(s, fpos) {
                continue;
            }
            let fe = word_end(s, fpos);
            if let Some(end) = close_call_tail(s, fe) {
                matched = Some(((fpos, fe), end));
                break;
            }
        }
        match matched {
            Some(((fs_, fe), end)) => {
                push_str(out, &s[fs_..fe]);
                pos = end;
            }
            None => pos += 1,
        }
    }
}

/// `\[[^\][]*\]` at `i` (the DISPATCH subscript form — no nested brackets):
/// position after `]`, or None.
pub(super) fn subscript_span(s: &[u8], i: usize) -> Option<usize> {
    if s.get(i) != Some(&b'[') {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && s[j] != b']' && s[j] != b'[' {
        j += 1;
    }
    if j < s.len() && s[j] == b']' {
        Some(j + 1)
    } else {
        None
    }
}

/// `\s*(?:->|\.)\s*` at `i` → position after.
#[inline]
pub(super) fn arrow_tail(s: &[u8], i: usize) -> Option<usize> {
    let a = arrow_at(s, skip_jsws(s, i))?;
    Some(skip_jsws(s, a))
}

/// ARRAY_DISPATCH_RE: /(?:\(\s*\*\s*)?\b(\w+)\s*\[[^\][]*\]\s*\)?\s*\(/g
pub(super) fn scan_array_dispatch(s: &[u8], out: &mut Vec<String>) {
    let mut pos = 0usize;
    while pos < s.len() {
        let b = s[pos];
        if b != b'(' && !(is_word(b) && boundary_before(s, pos)) {
            pos += 1;
            continue;
        }
        let name_start = if b == b'(' {
            let i = skip_jsws(s, pos + 1);
            if s.get(i) == Some(&b'*') {
                let j = skip_jsws(s, i + 1);
                // \b holds: the previous char is `*` or whitespace.
                if is_word_at(s, j) {
                    Some(j)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            Some(pos)
        };
        let matched = name_start.and_then(|ns| {
            let ne = word_end(s, ns);
            let sub = subscript_span(s, skip_jsws(s, ne))?;
            let end = close_call_tail(s, sub)?;
            Some(((ns, ne), end))
        });
        match matched {
            Some(((ns, ne), end)) => {
                push_str(out, &s[ns..ne]);
                pos = end;
            }
            None => pos += 1,
        }
    }
}
