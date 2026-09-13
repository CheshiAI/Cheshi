//! lexical support for cfnptr.

#[inline]
pub(super) fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

#[inline]
pub(super) fn is_word_at(s: &[u8], i: usize) -> bool {
    i < s.len() && is_word(s[i])
}

/// Byte length of the JS `\s` character starting at `i`, or 0 when `s[i]`
/// doesn't start one. JS \s = [\t\n\v\f\r    -
///    　﻿].
#[inline]
pub(super) fn jsws_len(s: &[u8], i: usize) -> usize {
    let Some(&b0) = s.get(i) else { return 0 };
    match b0 {
        0x09..=0x0D | 0x20 => 1,
        0xC2 if s.get(i + 1) == Some(&0xA0) => 2, // U+00A0
        0xE1 if s.get(i + 1) == Some(&0x9A) && s.get(i + 2) == Some(&0x80) => 3, // U+1680
        0xE2 => match (s.get(i + 1), s.get(i + 2)) {
            (Some(&0x80), Some(&b2)) if (0x80..=0x8A).contains(&b2) => 3, // U+2000-200A
            (Some(&0x80), Some(&0xA8)) => 3,                              // U+2028
            (Some(&0x80), Some(&0xA9)) => 3,                              // U+2029
            (Some(&0x80), Some(&0xAF)) => 3,                              // U+202F
            (Some(&0x81), Some(&0x9F)) => 3,                              // U+205F
            _ => 0,
        },
        0xE3 if s.get(i + 1) == Some(&0x80) && s.get(i + 2) == Some(&0x80) => 3, // U+3000
        0xEF if s.get(i + 1) == Some(&0xBB) && s.get(i + 2) == Some(&0xBF) => 3, // U+FEFF
        _ => 0,
    }
}

/// Advance past `\s*`.
#[inline]
pub(super) fn skip_jsws(s: &[u8], mut i: usize) -> usize {
    loop {
        let l = jsws_len(s, i);
        if l == 0 {
            return i;
        }
        i += l;
    }
}

/// End of the `\w+` run starting at `i` (caller checks `is_word_at(s, i)`).
#[inline]
pub(super) fn word_end(s: &[u8], mut i: usize) -> usize {
    while i < s.len() && is_word(s[i]) {
        i += 1;
    }
    i
}

/// JS `\b` before position `i` (position 0, or previous byte non-word).
#[inline]
pub(super) fn boundary_before(s: &[u8], i: usize) -> bool {
    i == 0 || !is_word(s[i - 1])
}

pub(super) fn find_bytes(s: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || s.len() < needle.len() {
        return None;
    }
    let mut i = from;
    while i + needle.len() <= s.len() {
        // memchr on the first byte keeps this fast on 20KB+ files.
        let off = s[i..s.len() - needle.len() + 1]
            .iter()
            .position(|&b| b == needle[0])?;
        i += off;
        if &s[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

pub(super) fn contains_bytes(s: &[u8], needle: &[u8]) -> bool {
    find_bytes(s, needle, 0).is_some()
}

/// `\bWORD\b` occurrence search from `from`.
pub(super) fn find_word(s: &[u8], word: &[u8], mut from: usize) -> Option<usize> {
    loop {
        let t = find_bytes(s, word, from)?;
        if boundary_before(s, t) && !is_word_at(s, t + word.len()) {
            return Some(t);
        }
        from = t + 1;
    }
}

// ---------- stripCommentsForRegex(src, 'c') ----------

/// Port of `stripCStyle(src, /*allowSingleQuoteStrings*/ false)`:
/// `/* */` and `//` comments blanked to spaces (newlines preserved), `"` and
/// backtick string interiors skipped verbatim (backtick spans lines — the JS
/// helper treats it as a template literal even for C), `'` NOT special.
///
/// Blanking is per UTF-16 CODE UNIT (one space per BMP char, two per astral
/// char), so the result equals the JS stripper's output EXACTLY as a string —
/// the scanners downstream see the identical character stream the JS regexes
/// see, and the strip differential oracle pins byte equality directly.
/// (Comment boundaries — `/*`, `*/`, `//`, quotes, `\n` — are all ASCII, so
/// the state machine's byte positions always land on char boundaries.)
pub fn strip_c(src: &[u8]) -> Vec<u8> {
    let n = src.len();
    let mut out = Vec::with_capacity(n);
    let mut copied = 0usize; // src[..copied] already emitted
    let mut i = 0;
    {
        let mut blank_to = |out: &mut Vec<u8>, start: usize, end: usize| {
            out.extend_from_slice(&src[copied..start]);
            emit_blank(out, &src[start..end]);
            copied = end;
        };
        while i < n {
            let c = src[i];
            let c2 = if i + 1 < n { src[i + 1] } else { 0 };
            if c == b'/' && c2 == b'*' {
                let start = i;
                i += 2;
                while i < n && !(src[i] == b'*' && i + 1 < n && src[i + 1] == b'/') {
                    i += 1;
                }
                if i < n {
                    i += 2;
                }
                blank_to(&mut out, start, i.min(n));
                continue;
            }
            if c == b'/' && c2 == b'/' {
                let start = i;
                while i < n && src[i] != b'\n' {
                    i += 1;
                }
                blank_to(&mut out, start, i);
                continue;
            }
            if c == b'"' || c == b'`' {
                let quote = c;
                i += 1;
                while i < n && src[i] != quote {
                    if src[i] == b'\\' && i + 1 < n {
                        i += 2;
                        continue;
                    }
                    if quote != b'`' && src[i] == b'\n' {
                        break;
                    }
                    i += 1;
                }
                if i < n && src[i] == quote {
                    i += 1;
                }
                continue;
            }
            i += 1;
        }
    }
    out.extend_from_slice(&src[copied..]);
    out
}

/// One space per UTF-16 code unit (`\n` preserved): ASCII and 2-3-byte chars
/// are one unit, 4-byte (astral) chars are a surrogate pair — two units.
pub(super) fn emit_blank(out: &mut Vec<u8>, region: &[u8]) {
    let mut i = 0;
    while i < region.len() {
        let b = region[i];
        if b == b'\n' {
            out.push(b'\n');
            i += 1;
            continue;
        }
        let len = if b < 0xC0 {
            1 // ASCII, or a stray continuation byte — count singly
        } else if b < 0xE0 {
            2
        } else if b < 0xF0 {
            3
        } else {
            4
        };
        out.push(b' ');
        if len == 4 {
            out.push(b' ');
        }
        i += len.min(region.len() - i);
    }
}

// ---------- shared regex tails ----------

/// `\(\s*(?:\w+\s+)*\*\s*(\w+)\s*\)\s*\(` matched at `open` (which must hold
/// `(`). Returns (name_range, end_after_second_paren). The `(?:\w+\s+)*`
/// group is greedy without backtracking: giving back an iteration repositions
/// `\*` onto a word char, which can never match, so greedy ≡ backtracked.
pub(super) fn fnptr_paren_tail(s: &[u8], open: usize) -> Option<((usize, usize), usize)> {
    let mut i = skip_jsws(s, open + 1);
    loop {
        if !is_word_at(s, i) {
            break;
        }
        let we = word_end(s, i);
        let wse = skip_jsws(s, we);
        if wse == we {
            break; // \w+ not followed by \s+ — the iteration fails, word not consumed
        }
        i = wse;
    }
    if s.get(i) != Some(&b'*') {
        return None;
    }
    i = skip_jsws(s, i + 1);
    if !is_word_at(s, i) {
        return None;
    }
    let name = (i, word_end(s, i));
    i = skip_jsws(s, name.1);
    if s.get(i) != Some(&b')') {
        return None;
    }
    i = skip_jsws(s, i + 1);
    if s.get(i) != Some(&b'(') {
        return None;
    }
    Some((name, i + 1))
}

/// `\s*\)?\s*\(` at `i` → position after the `(`. The optional `)` needs no
/// backtracking: retrying without a consumed `)` lands `\(` on that `)`.
pub(super) fn close_call_tail(s: &[u8], i: usize) -> Option<usize> {
    let mut j = skip_jsws(s, i);
    if s.get(j) == Some(&b')') {
        j = skip_jsws(s, j + 1);
    }
    if s.get(j) == Some(&b'(') {
        return Some(j + 1);
    }
    None
}

// ---------- per-file entry ----------

pub(super) fn push_str(out: &mut Vec<String>, bytes: &[u8]) {
    out.push(bytes_to_string(bytes));
}

#[inline]
pub(super) fn bytes_to_string(bytes: &[u8]) -> String {
    // All slice boundaries land on ASCII delimiters, so the content is valid
    // UTF-8 whenever the input string was; lossy keeps us total anyway.
    String::from_utf8_lossy(bytes).into_owned()
}

pub(super) fn dedup_in_order(v: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(v.len());
    for x in v {
        if seen.insert(x.clone()) {
            out.push(x);
        }
    }
    out
}

/// Line start offsets (byte offset of each line's first byte).
pub(super) fn line_starts(s: &[u8]) -> Vec<usize> {
    let mut out = vec![0usize];
    for (i, &b) in s.iter().enumerate() {
        if b == b'\n' {
            out.push(i + 1);
        }
    }
    out
}
