//! emission support for textutil.

use super::*;

/// Emit a non-default containment edge, such as a method attached to an
/// earlier receiver declaration.
pub fn emit_contains_edge(tables: &mut crate::buffers::Tables, source: u32, target: u32) {
    tables.push_edge(&crate::buffers::EdgeRow::new(
        source,
        target,
        crate::buffers::edge_kind_index("contains").unwrap(),
        crate::buffers::NONE_STR,
    ));
}

/// Source and storage fields used while encoding a node row. Some walkers keep
/// these fields directly while others own them through `WalkerState`; this
/// context gives both layouts the same storage boundary.
pub struct NodeRowEmitContext<'a> {
    pub file_path: &'a str,
    pub src: &'a str,
    pub line_starts: &'a [usize],
    pub stack: &'a [Scope],
    pub arena: &'a mut crate::buffers::Arena,
    pub tables: &'a mut crate::buffers::Tables,
    pub node_ids: &'a mut Vec<String>,
}

/// Emit a row from a consolidated walker state.
pub fn emit_node_row<'tree>(
    state: &mut WalkerState<'tree>,
    kind: &'static str,
    name: &str,
    node: Node<'tree>,
    extra: NodeExtra,
) -> Option<u32> {
    emit_node_row_in(
        NodeRowEmitContext {
            file_path: state.file_path,
            src: state.src,
            line_starts: &state.line_starts,
            stack: &state.stack,
            arena: &mut state.arena,
            tables: &mut state.tables,
            node_ids: &mut state.node_ids,
        },
        kind,
        name,
        node,
        extra,
    )
}

/// Emit the storage row and containment edge shared by every native walker.
/// Language adapters retain their own semantic hooks (inheritance, decorators,
/// value scopes), while this structural boundary keeps allocation, flags,
/// positions, qualified names, and IDs identical without clone-heavy copies.
pub fn emit_node_row_in<'tree>(
    context: NodeRowEmitContext<'_>,
    kind: &'static str,
    name: &str,
    node: Node<'tree>,
    extra: NodeExtra,
) -> Option<u32> {
    let NodeRowEmitContext {
        file_path,
        src,
        line_starts,
        stack,
        arena,
        tables,
        node_ids,
    } = context;
    if name.is_empty() {
        return None;
    }
    let start_line = node_line(node);
    let id = crate::ids::node_id(file_path, kind, name, start_line);
    let end_line = extra
        .end_line
        .unwrap_or_else(|| node.end_position().row as u32 + 1);
    let qualified = extra.qualified_name.unwrap_or_else(|| {
        join_qualified_name(
            stack
                .iter()
                .filter(|scope| scope.kind != "file")
                .map(|scope| scope.name.as_str()),
            name,
        )
    });

    let mut flags = crate::buffers::BoolFlags::default();
    if let Some(value) = extra.is_exported {
        flags.set(crate::buffers::FLAG_IS_EXPORTED, value);
    }
    if let Some(value) = extra.is_async {
        flags.set(crate::buffers::FLAG_IS_ASYNC, value);
    }
    if let Some(value) = extra.is_static {
        flags.set(crate::buffers::FLAG_IS_STATIC, value);
    }
    let decorators = match extra.decorators.as_deref() {
        Some(list) if !list.is_empty() => arena.put_list(list),
        _ => crate::buffers::NONE_STR,
    };
    let mut node_row = crate::buffers::NodeRow::new(crate::buffers::NodeRowInput {
        kind: crate::buffers::node_kind_index(kind).unwrap(),
        visibility: extra.visibility.unwrap_or(0),
        flags,
        start_line,
        end_line,
        start_column: node_column(src, line_starts, node),
        end_column: node_end_column(src, line_starts, node),
        name: arena.put(name),
        qualified_name: arena.put(&qualified),
        id: arena.put(&id),
        docstring: arena.put_opt(extra.docstring.as_deref()),
        signature: arena.put_opt(extra.signature.as_deref()),
        return_type: arena.put_opt(extra.return_type.as_deref()),
    });
    node_row.decorators = decorators;
    let row = tables.push_node(&node_row);
    node_ids.push(id);
    tables.push_edge(&crate::buffers::EdgeRow::new(
        top_scope_row(stack),
        row,
        crate::buffers::edge_kind_index("contains").unwrap(),
        crate::buffers::NONE_STR,
    ));
    Some(row)
}

/// Mutable storage and immutable source data needed by the shared value-ref
/// traversal. Keeping the encoding boundary together prevents language
/// adapters from passing the same four state fields independently.
pub struct ValueRefEmitContext<'a> {
    pub src: &'a str,
    pub node_ids: &'a [String],
    pub arena: &'a mut crate::buffers::Arena,
    pub tables: &'a mut crate::buffers::Tables,
}

/// Keep the fn-ref import gate identical across all language walkers.
pub fn record_import_name(imported_names: &mut HashSet<String>, name: &str) {
    if simple_name().is_match(name) {
        imported_names.insert(name.to_string());
    } else if let Some(capture) = qualified_import().captures(name) {
        imported_names.insert(capture[1].to_string());
    }
}

pub fn emit_state_ref(
    state: &mut WalkerState<'_>,
    from_row: u32,
    name: &str,
    kind: u8,
    line: u32,
    column: u32,
) {
    let name_ref = state.arena.put(name);
    state.tables.push_ref(&crate::buffers::RefRow::new(
        from_row, kind, line, column, name_ref,
    ));
    if kind == crate::buffers::edge_kind_index("imports").unwrap() {
        record_import_name(&mut state.imported_names, name);
    }
}

pub fn emit_state_ref_at(
    state: &mut WalkerState<'_>,
    from_row: u32,
    name: &str,
    kind_code: u8,
    node: Node,
) {
    emit_state_ref(
        state,
        from_row,
        name,
        kind_code,
        node_line(node),
        node_column(state.src, &state.line_starts, node),
    );
}

/// Emit a reference with the optional wire-level flags used by PHP trait-use
/// and the other language-specific reference hooks.
pub fn emit_state_ref_flagged(
    state: &mut WalkerState<'_>,
    from_row: u32,
    name: &str,
    kind: u8,
    node: Node,
    flags: u8,
) {
    let reference_name = state.arena.put(name);
    state.tables.push_ref_flagged(
        &crate::buffers::RefRow::new(
            from_row,
            kind,
            node_line(node),
            node_column(state.src, &state.line_starts, node),
            reference_name,
        ),
        flags,
    );
    if kind == crate::buffers::edge_kind_index("imports").unwrap() {
        record_import_name(&mut state.imported_names, name);
    }
}

/// Emit a call edge after applying the shared parenthesized-callee normalization.
pub fn emit_state_call_ref(state: &mut WalkerState<'_>, from_row: u32, raw_name: &str, node: Node) {
    let name = normalize_parenthesized_name(raw_name);
    if name.is_empty() {
        return;
    }
    emit_state_ref_at(
        state,
        from_row,
        &name,
        crate::buffers::edge_kind_index("calls").unwrap(),
        node,
    );
}

/// Emit the standard decorator edge at the annotation node's source position.
pub fn emit_state_decorator_ref(
    state: &mut WalkerState<'_>,
    from_row: u32,
    name: &str,
    node: Node,
) {
    emit_state_ref_at(
        state,
        from_row,
        name,
        crate::buffers::edge_kind_index("decorates").unwrap(),
        node,
    );
}

/// Emit the file node that every native language walker starts with and return
/// its basename for the initial file scope.  The wire fields are language
/// independent; keeping them here prevents each adapter from carrying the
/// same 25-line row construction.
pub fn emit_file_node(
    file_path: &str,
    source: &str,
    arena: &mut crate::buffers::Arena,
    tables: &mut crate::buffers::Tables,
    node_ids: &mut Vec<String>,
) -> String {
    let line_count = source.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1;
    let base_name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    let file_id_string = crate::ids::file_node_id(file_path);
    let file_id = arena.put(&file_id_string);
    let name_ref = arena.put(base_name);
    let qualified_name = arena.put(file_path);
    let mut flags = crate::buffers::BoolFlags::default();
    flags.set(crate::buffers::FLAG_IS_EXPORTED, false);
    tables.push_node(&crate::buffers::NodeRow::new(
        crate::buffers::NodeRowInput {
            kind: crate::buffers::node_kind_index("file").unwrap(),
            visibility: 0,
            flags,
            start_line: 1,
            end_line: line_count,
            start_column: 0,
            end_column: 0,
            name: name_ref,
            qualified_name,
            id: file_id,
            docstring: crate::buffers::NONE_STR,
            signature: crate::buffers::NONE_STR,
            return_type: crate::buffers::NONE_STR,
        },
    ));
    node_ids.push(file_id_string);
    base_name.to_string()
}

/// Finish a native extraction with the shared flat-buffer contract.  The
/// language walkers differ in traversal and metadata policy, but all of them
/// encode the same tables, arena, and kernel duration at this boundary.
pub fn finish_emit(
    started_at: std::time::Instant,
    tables: crate::buffers::Tables,
    arena: crate::buffers::Arena,
) -> crate::buffers::EmitOut {
    let duration_ms = started_at.elapsed().as_secs_f64() * 1000.0;
    let meta =
        crate::buffers::build_meta(&tables, arena.len(), crate::buffers::NONE_STR, duration_ms);
    crate::buffers::EmitOut {
        meta,
        nodes: tables.nodes,
        edges: tables.edges,
        refs: tables.refs,
        arena: arena.into_vec(),
    }
}
