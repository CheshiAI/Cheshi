//! syntax support for textutil.

use super::*;

pub fn reject_error_tree(tree: &Tree, message: &str) -> Result<(), String> {
    if tree.root_node().has_error() {
        return Err(message.to_string());
    }
    Ok(())
}

/// Parse one native-kernel source with the language-specific error label used
/// by every walker. Keeping parser setup here prevents each adapter from
/// copying the same `Parser::new`/`set_language`/`parse` boundary.
pub fn parse_tree(grammar: &Language, source: &str, language: &str) -> Result<Tree, String> {
    let mut parser = Parser::new();
    parser
        .set_language(grammar)
        .map_err(|error| format!("set_language({language}) failed: {error}"))?;
    parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())
}

/// Iterate over named Tree-sitter children without allocating a cursor.
///
/// The native walkers all need this same field-order-preserving view. Keeping
/// it here prevents each language adapter from growing a subtly different
/// `(0..named_child_count()).filter_map(...)` loop.
pub fn named_children(node: Node) -> impl Iterator<Item = Node> {
    (0..node.named_child_count()).filter_map(move |index| node.named_child(index))
}

pub fn bounded_named_subtree(root: Node, max_nodes: usize) -> Vec<Node> {
    let mut stack = vec![root];
    let mut nodes = Vec::new();
    while let Some(node) = stack.pop() {
        if nodes.len() >= max_nodes {
            break;
        }
        nodes.push(node);
        stack.extend(named_children(node));
    }
    nodes
}

/// Collect a named subtree in the same pre-order traversal used by the
/// language adapters' recursive type-reference walkers.
pub fn named_subtree_preorder(root: Node) -> Vec<Node> {
    fn visit<'tree>(node: Node<'tree>, nodes: &mut Vec<Node<'tree>>) {
        nodes.push(node);
        for child in named_children(node) {
            visit(child, nodes);
        }
    }

    let mut nodes = Vec::new();
    visit(root, &mut nodes);
    nodes
}

pub fn count_shadow_declarations<F>(
    root: Node,
    max_nodes: usize,
    targets: &HashMap<String, u32>,
    mut declared_name: F,
) -> HashMap<String, u32>
where
    F: FnMut(Node) -> Option<String>,
{
    count_shadow_declarations_many(root, max_nodes, targets, |node| {
        declared_name(node).into_iter().collect()
    })
}

pub fn count_shadow_declarations_many<F>(
    root: Node,
    max_nodes: usize,
    targets: &HashMap<String, u32>,
    mut declared_names: F,
) -> HashMap<String, u32>
where
    F: FnMut(Node) -> Vec<String>,
{
    let mut declaration_counts = HashMap::new();
    for node in bounded_named_subtree(root, max_nodes) {
        for name in declared_names(node) {
            if targets.contains_key(&name) {
                *declaration_counts.entry(name).or_insert(0) += 1;
            }
        }
    }
    declaration_counts
}

/// Collect Python/Ruby assignment LHS names for value-reference shadowing.
/// Tuple-like patterns count their direct identifier children exactly as the
/// native adapters do; typed/constant LHS nodes remain uncounted.
pub fn assignment_declared_names(node: Node, src: &str) -> Vec<String> {
    assignment_declared_names_with_kinds(node, src, &["identifier"], &["identifier"])
}

/// Collect assignment LHS names with grammar-specific identifier kinds.  A
/// direct LHS can use one set of node kinds while destructuring children use
/// another; keeping that shape policy here avoids repeating the same fallback
/// walk in each language adapter.
pub fn assignment_declared_names_with_kinds(
    node: Node,
    src: &str,
    direct_kinds: &[&str],
    nested_kinds: &[&str],
) -> Vec<String> {
    if node.kind() != "assignment" {
        return Vec::new();
    }
    let Some(left) = child_by_fields(node, &["left", "pattern"], 0) else {
        return Vec::new();
    };
    if direct_kinds.contains(&left.kind()) {
        vec![source_text(src, left).to_string()]
    } else {
        named_children(left)
            .filter(|child| nested_kinds.contains(&child.kind()))
            .map(|child| source_text(src, child).to_string())
            .collect()
    }
}

/// Return the first row index whose metadata satisfies the caller's owner
/// policy.  Language adapters retain their metadata shape and kind set while
/// the position-to-row conversion remains shared.
pub fn first_row_matching<T, F>(items: &[T], predicate: F) -> Option<u32>
where
    F: FnMut(&T) -> bool,
{
    items.iter().position(predicate).map(|index| index as u32)
}

/// Remove declarations that shadow all file-scope value-reference targets.
pub fn prune_shadowed_targets(
    targets: &mut HashMap<String, u32>,
    declaration_counts: &HashMap<String, u32>,
    target_counts: &HashMap<String, u32>,
) {
    for name in shadowed_names(declaration_counts, target_counts) {
        targets.remove(&name);
    }
}

/// Resolve the first available grammar field and then a positional fallback.
pub fn child_by_fields<'tree>(
    node: Node<'tree>,
    fields: &[&'static str],
    fallback_index: usize,
) -> Option<Node<'tree>> {
    fields
        .iter()
        .find_map(|field| node.child_by_field_name(field))
        .or_else(|| node.named_child(fallback_index))
}

pub fn child_by_fields_if_named_count<'tree>(
    node: Node<'tree>,
    fields: &[&'static str],
    fallback_index: usize,
    minimum_count: usize,
) -> Option<Node<'tree>> {
    fields
        .iter()
        .find_map(|field| node.child_by_field_name(field))
        .or_else(|| {
            (node.named_child_count() >= minimum_count)
                .then(|| node.named_child(fallback_index))
                .flatten()
        })
}

/// Whether a syntax node is the callee child of a call expression.
pub fn is_call_callee(node: Node) -> bool {
    is_call_callee_in(node, &["call_expression"], &["function", "method"])
}

pub fn is_call_callee_in(
    node: Node,
    call_kinds: &[&'static str],
    callee_fields: &[&'static str],
) -> bool {
    node.parent().is_some_and(|parent| {
        call_kinds.contains(&parent.kind())
            && child_by_fields(parent, callee_fields, 0)
                .is_some_and(|callee| callee.start_byte() == node.start_byte())
    })
}

pub fn preceding_named_children(node: Node, before: usize) -> impl Iterator<Item = Node> {
    (0..before)
        .rev()
        .filter_map(move |index| node.named_child(index))
}

/// Return decorator/annotation nodes in the same order as the language
/// adapters' shared sibling scan: direct children (including `modifiers`
/// descendants), then immediately preceding annotation siblings in reverse.
pub fn decorator_nodes(decl: Node) -> Vec<Node> {
    let mut nodes = Vec::new();
    for child in named_children(decl) {
        nodes.push(child);
        if child.kind() == "modifiers" {
            nodes.extend(named_children(child));
        }
    }
    if let Some(parent) = decl.parent() {
        let decl_start = decl.start_byte();
        let decl_index =
            named_children(parent).position(|sibling| sibling.start_byte() == decl_start);
        if let Some(index) = decl_index {
            for sibling in preceding_named_children(parent, index) {
                if !matches!(
                    sibling.kind(),
                    "decorator" | "annotation" | "marker_annotation"
                ) {
                    break;
                }
                nodes.push(sibling);
            }
        }
    }
    nodes
}

/// Extract the normalized decorator name used by the Dart/Scala adapters.
pub fn decorator_name(node: Node, src: &str) -> Option<String> {
    if !matches!(
        node.kind(),
        "decorator" | "annotation" | "marker_annotation" | "attribute"
    ) {
        return None;
    }
    let target = named_children(node).find_map(|child| {
        if child.kind() == "call_expression" {
            child
                .child_by_field_name("function")
                .or_else(|| child.named_child(0))
        } else if matches!(
            child.kind(),
            "identifier"
                | "member_expression"
                | "scoped_identifier"
                | "navigation_expression"
                | "user_type"
                | "type_identifier"
        ) {
            Some(child)
        } else {
            None
        }
    })?;
    let name = strip_generic_and_qualifier(source_text(src, target));
    (!name.is_empty()).then_some(name)
}

/// Resolve a named field, falling back to the last named child.
pub fn field_or_last_named<'tree>(node: Node<'tree>, field: &str) -> Option<Node<'tree>> {
    node.child_by_field_name(field).or_else(|| {
        let count = node.named_child_count();
        (count > 0).then(|| node.named_child(count - 1)).flatten()
    })
}

pub fn has_named_child_kind(node: Node, kind: &str) -> bool {
    named_children(node).any(|child| child.kind() == kind)
}

pub fn has_child_kind(node: Node, kind: &str) -> bool {
    (0..node.child_count())
        .filter_map(|index| node.child(index))
        .any(|child| child.kind() == kind)
}

pub fn first_named_child_kind<'tree>(node: Node<'tree>, kind: &str) -> Option<Node<'tree>> {
    named_children(node).find(|child| child.kind() == kind)
}

pub fn first_named_child_kind_any<'tree>(node: Node<'tree>, kinds: &[&str]) -> Option<Node<'tree>> {
    named_children(node).find(|child| kinds.contains(&child.kind()))
}

/// Locate the first package header and its first identifier-shaped child.
/// The header is selected before looking for its identifier so a malformed
/// first header still preserves each grammar's original stop-after-first
/// behavior.
pub fn first_package_identifier<'tree>(
    root: Node<'tree>,
    header_kind: &str,
    identifier_kinds: &[&str],
) -> Option<(Node<'tree>, Node<'tree>)> {
    let header = named_children(root).find(|child| child.kind() == header_kind)?;
    let identifier = first_named_child_kind_any(header, identifier_kinds)?;
    Some((header, identifier))
}

pub fn first_package_name<'tree>(
    src: &str,
    root: Node<'tree>,
    header_kind: &str,
    identifier_kinds: &[&str],
) -> Option<(Node<'tree>, String)> {
    let (header, identifier) = first_package_identifier(root, header_kind, identifier_kinds)?;
    trimmed_non_empty_node_text(src, identifier).map(|name| (header, name))
}

/// Resolve a declaration name from its named field or the first identifier-
/// shaped child. Returning `None` lets a language preserve its own anonymous
/// fallback without repeating this Tree-sitter shape scan.
pub fn declaration_name(node: Node, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .or_else(|| {
            first_named_child_kind_any(
                node,
                &[
                    "identifier",
                    "type_identifier",
                    "simple_identifier",
                    "constant",
                ],
            )
        })
        .map(|name| source_text(source, name).to_string())
}

pub fn child_by_field_or_kind<'tree>(
    node: Node<'tree>,
    field: &str,
    kind: &str,
) -> Option<Node<'tree>> {
    node.child_by_field_name(field)
        .or_else(|| first_named_child_kind(node, kind))
}

/// Build a declaration signature from two optional Tree-sitter fields.
pub fn signature_from_fields(
    node: Node,
    source: &str,
    params_field: &str,
    return_field: &str,
    separator: &str,
) -> Option<String> {
    let params = node.child_by_field_name(params_field)?;
    let mut signature = source_text(source, params).to_string();
    if let Some(return_node) = node.child_by_field_name(return_field) {
        signature.push_str(separator);
        signature.push_str(source_text(source, return_node));
    }
    Some(signature)
}
