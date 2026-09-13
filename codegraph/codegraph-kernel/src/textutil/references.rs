//! references support for textutil.

use super::*;

pub fn is_ungated_fn_ref_name(name: &str) -> bool {
    name.starts_with("this.") || name.contains("::")
}

pub fn is_fn_ref_stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this"
            | "self"
            | "super"
            | "null"
            | "nil"
            | "true"
            | "false"
            | "undefined"
            | "new"
            | "NULL"
            | "nullptr"
            | "None"
    )
}

/// Record a function-as-value candidate after applying the shared stoplist.
/// Capture boundaries remain language-specific; candidate encoding does not.
pub fn record_fn_ref_candidate(
    candidates: &mut Vec<FnRefCandidate>,
    from: u32,
    name: &str,
    node: Node,
) {
    if name.is_empty() || is_fn_ref_stoplisted(name) {
        return;
    }
    let position = node.start_position();
    candidates.push(FnRefCandidate {
        from,
        name: name.to_string(),
        line: position.row as u32 + 1,
        column_byte: node.start_byte(),
        row: position.row,
    });
}

pub fn is_known_fn_ref_name(
    name: &str,
    defined_names: &HashSet<String>,
    imported_names: &HashSet<String>,
) -> bool {
    defined_names.contains(name) || imported_names.contains(name)
}

/// Walk a function-reference subtree with the shared depth and boundary
/// policy used by property hooks.  The language adapter only supplies the
/// node kinds that terminate capture.
pub fn walk_fn_ref_subtree<'tree, F>(
    node: Node<'tree>,
    depth: u32,
    max_depth: u32,
    stop_kinds: &[&'static str],
    visit: &mut F,
) where
    F: FnMut(Node<'tree>),
{
    walk_named_subtree(
        node,
        depth,
        max_depth,
        &|candidate, candidate_depth| candidate_depth > 0 && stop_kinds.contains(&candidate.kind()),
        &mut |candidate, _| visit(candidate),
    );
}

pub fn emit_type_identifier_refs<F>(
    state: &mut WalkerState<'_>,
    root: Node,
    from_row: u32,
    is_builtin: F,
) where
    F: Fn(&str) -> bool,
{
    for node in named_subtree_preorder(root) {
        if node.kind() != "type_identifier" {
            continue;
        }
        let name = source_text(state.src, node);
        if !name.is_empty() && !is_builtin(name) {
            emit_state_ref_at(
                state,
                from_row,
                name,
                crate::buffers::edge_kind_index("references").unwrap(),
                node,
            );
        }
    }
}

/// Visit type identifiers without descending into a matched identifier.
pub fn walk_type_identifier_nodes<'tree, F>(node: Node<'tree>, visit: &mut F)
where
    F: FnMut(Node<'tree>),
{
    if node.kind() == "type_identifier" {
        visit(node);
        return;
    }
    for child in named_children(node) {
        walk_type_identifier_nodes(child, visit);
    }
}

/// Return names whose declaration count exceeds the file-scope target count.
pub fn shadowed_names(
    declaration_counts: &HashMap<String, u32>,
    target_counts: &HashMap<String, u32>,
) -> Vec<String> {
    declaration_counts
        .iter()
        .filter(|(name, count)| **count > target_counts.get(*name).copied().unwrap_or(1))
        .map(|(name, _)| name.to_string())
        .collect()
}

/// Emit value-reference edges for every captured scope after its language
/// adapter has applied the language-specific shadow-pruning pass.  The edge
/// walk is identical across language grammars; only Dart needs to include a
/// sibling body because its grammar stores function bodies outside the
/// signature node.  Keeping that exception as data avoids copying the
/// 70-line traversal into every walker while preserving traversal order.
pub fn emit_value_ref_edges(
    context: ValueRefEmitContext<'_>,
    scopes: &[ValueScope<'_>],
    targets: &HashMap<String, u32>,
    max_nodes: usize,
    sibling_body_kinds: &[&str],
) {
    let ValueRefEmitContext {
        src,
        node_ids,
        arena,
        tables,
    } = context;
    if targets.is_empty() || scopes.is_empty() {
        return;
    }
    let refs_kind = crate::buffers::edge_kind_index("references").unwrap();
    for scope in scopes {
        let mut roots = Vec::with_capacity(2);
        if let Some(sibling) = scope.node.next_named_sibling() {
            if sibling_body_kinds.contains(&sibling.kind()) {
                // The Dart walker historically visited the sibling body before
                // the signature node, so keep that order for byte-identical refs.
                roots.push(sibling);
            }
        }
        roots.push(scope.node);

        let mut seen: HashSet<String> = HashSet::new();
        for root in roots {
            for node in bounded_named_subtree(root, max_nodes) {
                if !matches!(
                    node.kind(),
                    "identifier" | "constant" | "name" | "simple_identifier"
                ) {
                    continue;
                }
                let ref_name = source_text(src, node);
                let Some(&target_row) = targets.get(ref_name) else {
                    continue;
                };
                let target_id = node_ids[target_row as usize].as_str();
                if target_id == node_ids[scope.row as usize].as_str()
                    || ref_name == scope.name
                    || !seen.insert(target_id.to_string())
                {
                    continue;
                }
                let meta = arena.put(r#"{"valueRef":true}"#);
                tables.push_edge(&crate::buffers::EdgeRow::new(
                    scope.row, target_row, refs_kind, meta,
                ));
            }
        }
    }
}

pub fn emit_state_value_ref_edges<'tree>(
    state: &mut WalkerState<'tree>,
    scopes: &[ValueScope<'tree>],
    targets: &HashMap<String, u32>,
    max_nodes: usize,
    excluded_names: &[&str],
) {
    emit_value_ref_edges(
        ValueRefEmitContext {
            src: state.src,
            node_ids: &state.node_ids,
            arena: &mut state.arena,
            tables: &mut state.tables,
        },
        scopes,
        targets,
        max_nodes,
        excluded_names,
    );
}

/// Inputs required to encode pending function references. The candidate list
/// is owned because flushing consumes it; all remaining fields borrow the
/// walker's current storage and symbol tables for the duration of the flush.
pub struct FnRefFlushInput<'a> {
    pub candidates: Vec<FnRefCandidate>,
    pub file_path: &'a str,
    pub node_ids: &'a [String],
    pub src: &'a str,
    pub line_starts: &'a [usize],
    pub arena: &'a mut crate::buffers::Arena,
    pub tables: &'a mut crate::buffers::Tables,
    pub defined_names: &'a HashSet<String>,
    pub imported_names: &'a HashSet<String>,
}

/// Flush the standard function-as-value candidate set shared by language
/// walkers.  Language-specific capture rules remain in each adapter; the
/// final generated-file, known-name, ID-string dedupe, and row encoding do not.
pub fn flush_fn_ref_candidates(input: FnRefFlushInput<'_>) {
    let FnRefFlushInput {
        candidates,
        file_path,
        node_ids,
        src,
        line_starts,
        arena,
        tables,
        defined_names,
        imported_names,
    } = input;
    if candidates.is_empty() || is_generated_file(file_path) {
        return;
    }
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for candidate in candidates {
        if !is_ungated_fn_ref_name(&candidate.name)
            && !is_known_fn_ref_name(&candidate.name, defined_names, imported_names)
        {
            continue;
        }
        if !seen.insert((
            node_ids[candidate.from as usize].clone(),
            candidate.name.clone(),
        )) {
            continue;
        }
        let column = col16(src, line_starts, candidate.row, candidate.column_byte);
        let name_ref = arena.put(&candidate.name);
        tables.push_ref(&crate::buffers::RefRow::new(
            candidate.from,
            crate::buffers::FUNCTION_REF_CODE,
            candidate.line,
            column,
            name_ref,
        ));
    }
}

/// Flush a walker's pending function-reference candidates through the shared
/// storage boundary.
pub fn flush_state_fn_ref_candidates(state: &mut WalkerState<'_>) {
    flush_fn_ref_candidates(FnRefFlushInput {
        candidates: std::mem::take(&mut state.fn_ref_cands),
        file_path: state.file_path,
        node_ids: &state.node_ids,
        src: state.src,
        line_starts: &state.line_starts,
        arena: &mut state.arena,
        tables: &mut state.tables,
        defined_names: &state.defined_fn_names,
        imported_names: &state.imported_names,
    });
}

/// Walk a named subtree while allowing a language adapter to stop at its own
/// lambda/function boundaries.
pub fn walk_named_subtree<'tree, F, S>(
    node: Node<'tree>,
    depth: u32,
    max_depth: u32,
    stop: &S,
    visit: &mut F,
) where
    F: FnMut(Node<'tree>, u32),
    S: Fn(Node<'tree>, u32) -> bool,
{
    if depth > max_depth || (depth > 0 && stop(node, depth)) {
        return;
    }
    visit(node, depth);
    for child in named_children(node) {
        walk_named_subtree(child, depth + 1, max_depth, stop, visit);
    }
}
