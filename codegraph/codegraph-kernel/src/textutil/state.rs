//! state support for textutil.

use super::*;

/// Shared extraction bookkeeping used by native language walkers.
#[derive(Clone)]
pub struct Scope {
    pub row: u32,
    pub kind: &'static str,
    pub name: String,
}

pub struct ValueScope<'t> {
    pub row: u32,
    pub node: Node<'t>,
    pub name: String,
}

pub struct FnRefCandidate {
    pub from: u32,
    pub name: String,
    pub line: u32,
    pub column_byte: usize,
    pub row: usize,
}

#[derive(Default)]
pub struct NodeExtra {
    pub docstring: Option<String>,
    pub signature: Option<String>,
    pub qualified_name: Option<String>,
    pub decorators: Option<Vec<String>>,
    pub end_line: Option<u32>,
    pub visibility: Option<u8>,
    pub is_static: Option<bool>,
    pub is_async: Option<bool>,
    pub is_exported: Option<bool>,
    pub return_type: Option<String>,
}

pub struct WalkerState<'t> {
    pub src: &'t str,
    pub file_path: &'t str,
    pub line_starts: Vec<usize>,
    pub arena: crate::buffers::Arena,
    pub tables: crate::buffers::Tables,
    pub stack: Vec<Scope>,
    pub node_ids: Vec<String>,
    pub defined_fn_names: HashSet<String>,
    pub imported_names: HashSet<String>,
    pub fn_ref_cands: Vec<FnRefCandidate>,
    pub fs_values: HashMap<String, u32>,
    pub fs_value_counts: HashMap<String, u32>,
    pub value_scopes: Vec<ValueScope<'t>>,
}

impl<'t> WalkerState<'t> {
    pub fn new(file_path: &'t str, src: &'t str) -> Self {
        Self {
            src,
            file_path,
            line_starts: line_starts(src),
            arena: crate::buffers::Arena::default(),
            tables: crate::buffers::Tables::default(),
            stack: Vec::new(),
            node_ids: Vec::new(),
            defined_fn_names: HashSet::new(),
            imported_names: HashSet::new(),
            fn_ref_cands: Vec::new(),
            fs_values: HashMap::new(),
            fs_value_counts: HashMap::new(),
            value_scopes: Vec::new(),
        }
    }
}

pub fn top_scope_row(stack: &[Scope]) -> u32 {
    stack.last().map(|scope| scope.row).unwrap_or(0)
}

pub fn inside_class_like(stack: &[Scope]) -> bool {
    stack
        .last()
        .map(|scope| is_class_like_scope_kind(scope.kind))
        .unwrap_or(false)
}

pub fn push_scope(stack: &mut Vec<Scope>, row: u32, kind: &'static str, name: String) {
    stack.push(Scope { row, kind, name });
}

/// Read-only walker conveniences shared through a trait so language adapters
/// do not each carry the same text/position/scope method block.
pub trait WalkerHelpers<'tree> {
    fn walker_state(&self) -> &WalkerState<'tree>;

    fn text(&self, node: Node<'tree>) -> &'tree str {
        source_text(self.walker_state().src, node)
    }

    fn top_row(&self) -> u32 {
        top_scope_row(&self.walker_state().stack)
    }

    fn inside_class_like(&self) -> bool {
        inside_class_like(&self.walker_state().stack)
    }
}

pub trait WalkerScope<'tree>: WalkerHelpers<'tree> {
    fn walker_state_mut(&mut self) -> &mut WalkerState<'tree>;

    fn with_scope<F>(&mut self, row: u32, kind: &'static str, name: String, visit: F)
    where
        F: FnOnce(&mut Self),
    {
        self.walker_state_mut()
            .stack
            .push(Scope { row, kind, name });
        visit(self);
        self.walker_state_mut().stack.pop();
    }
}
