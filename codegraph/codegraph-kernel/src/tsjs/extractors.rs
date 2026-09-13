//! The extract_* family — continuation of the Walker impl (see mod.rs for the
//! porting contract). Each function mirrors its namesake in
//! src/extraction/tree-sitter.ts; TS-file line references are as of the R2
//! port. Bug-for-bug fidelity is deliberate — fix the TS side first.

use super::{
    body_of, is_builtin_type, is_literal_receiver, is_react_hoc, is_variable_type,
    is_vue_collection_name, Extra, Scope, Walker,
};
use crate::buffers::edge_kind_index;
use crate::textutil as util;
use tree_sitter::Node;

mod declarations;
mod frameworks;
mod references;

/// `.replace(/\s+/g, ' ')` for the tuple-contract signature.
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}
