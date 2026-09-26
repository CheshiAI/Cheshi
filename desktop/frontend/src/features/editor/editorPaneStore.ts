import { Transaction, type EditorState } from '@codemirror/state';
import { insertSplitPane, removeSplitPane, resizeSplitPane, type SplitLayoutNode, type SplitPaneDirection } from '../../shared/ui/splitPaneModel';
import type { WorkspaceTab } from './workspaceEditorModel';
import { parseEditorPaneSession, pruneEditorPaneLayout, type EditorPaneSession } from './editorPaneLayout';
import { DEFAULT_WORKSPACE_PROBLEMS_RATIO } from './WorkspaceProblemsResizer';

export interface EditorPaneGroup {
  id: string;
  tabs: WorkspaceTab[];
  selectedPath: string | null;
  problemsOpen: boolean;
  problemsRatio: number;
}
interface EditorPaneState {
  layout: SplitLayoutNode;
  groups: Record<string, EditorPaneGroup>;
  activeId: string;
}

/** Map inactive views through document edits without discarding their selection or undo history. */
export function updateEditorStateDocument(state: EditorState | undefined, content: string): EditorState | undefined {
  if (!state || state.doc.toString() === content) return state;
  const previous = state.doc.toString();
  let start = 0;
  while (start < Math.min(previous.length, content.length) && previous[start] === content[start]) start++;
  let end = 0;
  while (end < Math.min(previous.length, content.length) - start
    && previous[previous.length - end - 1] === content[content.length - end - 1]) end++;
  return state.update({ changes: { from: start, to: previous.length - end, insert: content.slice(start, content.length - end) },
    annotations: Transaction.addToHistory.of(false) }).state;
}

export function createEditorPaneStore() {
  const first: EditorPaneGroup = { id: 'editor-main', tabs: [], selectedPath: null,
    problemsOpen: true, problemsRatio: DEFAULT_WORKSPACE_PROBLEMS_RATIO };
  let state: EditorPaneState = { layout: { type: 'pane', paneId: first.id }, groups: { [first.id]: first }, activeId: first.id };
  const listeners = new Set<() => void>();
  const captures = new Map<string, () => void>();
  const busy = new Set<string>();
  const publish = (next: EditorPaneState) => { state = next; for (const listener of listeners) listener(); };
  const allTabs = () => [...new Map(Object.values(state.groups).flatMap(g => g.tabs).map(t => [t.path, t])).values()];
  const capture = (id: string) => captures.get(id)?.();
  const prune = (next: EditorPaneState) => {
    for (const group of Object.values(next.groups)) {
      if (group.tabs.length || Object.keys(next.groups).length === 1) continue;
      next.layout = removeSplitPane(next.layout, group.id)!;
      delete next.groups[group.id];
    }
    if (!next.groups[next.activeId]) next.activeId = Object.keys(next.groups)[0]!;
    return next;
  };
  const snapshot = (): EditorPaneSession => ({ layout: state.layout, activeId: state.activeId,
    groups: Object.fromEntries(Object.values(state.groups).map(g => [g.id, {
      paths: g.tabs.map(t => t.path), selectedPath: g.selectedPath,
      problemsOpen: g.problemsOpen, problemsRatio: g.problemsRatio,
    }])) });
  return {
    nextGeneration: { current: 0 },
    saving: { current: false },
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    allTabs,
    snapshot,
    capture,
    registerCapture(id: string, fn: () => void) {
      captures.set(id, fn);
      return () => { if (captures.get(id) === fn) captures.delete(id); };
    },
    setBusy(id: string, value: boolean) { if (value) busy.add(id); else busy.delete(id); },
    isBusy: () => busy.size > 0,
    activate(id: string) { if (state.groups[id] && state.activeId !== id) publish({ ...state, activeId: id }); },
    configure(id: string, options: Partial<Pick<EditorPaneGroup, 'problemsOpen' | 'problemsRatio'>>) {
      const group = state.groups[id];
      if (group) publish({ ...state, groups: { ...state.groups, [id]: { ...group, ...options } } });
    },
    select(id: string, path: string | null) {
      const group = state.groups[id];
      if (!group || group.selectedPath === path) return;
      publish({ ...state, groups: { ...state.groups, [id]: { ...group, selectedPath: path } } });
    },
    replace(id: string, update: (tabs: WorkspaceTab[]) => WorkspaceTab[]) {
      const group = state.groups[id];
      if (!group) return;
      const tabs = update(group.tabs);
      if (tabs === group.tabs) return;
      const changes = new Map(tabs.filter(t => group.tabs.find(old => old.path === t.path) !== t).map(t => [t.path, t]));
      const groups = { ...state.groups, [id]: { ...group, tabs } };
      for (const other of Object.values(groups)) {
        if (other.id === id) continue;
        groups[other.id] = { ...other, tabs: other.tabs.map(tab => {
          const changed = changes.get(tab.path);
          if (!changed) return tab;
          return { ...changed, editorState: changed.loadGeneration === tab.loadGeneration
            ? updateEditorStateDocument(tab.editorState, changed.draftContent) : undefined };
        }) };
      }
      publish({ ...state, groups });
    },
    replaceDocuments(update: (tabs: WorkspaceTab[]) => WorkspaceTab[]) {
      const documents = new Map(update(allTabs()).map(tab => [tab.path, tab]));
      const groups = Object.fromEntries(Object.values(state.groups).map(group => [group.id, { ...group,
        tabs: group.tabs.map(tab => {
          const updated = documents.get(tab.path);
          if (!updated) return tab;
          return { ...updated, editorState: updated.loadGeneration === tab.loadGeneration
            ? updateEditorStateDocument(tab.editorState, updated.draftContent) : undefined };
        }),
      }]));
      publish({ ...state, groups });
    },
    sharedElsewhere(id: string, path: string) {
      return Object.values(state.groups).some(g => g.id !== id && g.tabs.some(t => t.path === path));
    },
    closeEmpty(id: string) {
      if (state.groups[id]?.tabs.length || Object.keys(state.groups).length === 1) return;
      publish(prune({ ...state, groups: { ...state.groups } }));
    },
    place(tab: WorkspaceTab, target: string, direction: SplitPaneDirection | null, source?: string) {
      if (!state.groups[target] || (source && !state.groups[source]?.tabs.some(t => t.path === tab.path))) return null;
      if (source) { capture(source); tab = state.groups[source]!.tabs.find(t => t.path === tab.path)!; }
      else tab = allTabs().find(t => t.path === tab.path) ?? tab;
      const groups = { ...state.groups };
      let layout = state.layout;
      let destination = target;
      if (direction) {
        if (Object.keys(groups).length >= 32) return null;
        destination = `editor-${crypto.randomUUID()}`;
        groups[destination] = { ...first, id: destination };
        layout = insertSplitPane(layout, target, destination, direction, `split-${crypto.randomUUID()}`);
      }
      const group = groups[destination]!;
      groups[destination] = { ...group, selectedPath: tab.path,
        tabs: group.tabs.some(t => t.path === tab.path) ? group.tabs : [...group.tabs, tab] };
      // Splitting a pane's only tab creates a second view; otherwise dragging transfers the tab.
      if (source && source !== destination && !(source === target && direction && groups[source]!.tabs.length === 1)) {
        const original = groups[source]!;
        const tabs = original.tabs.filter(t => t.path !== tab.path);
        groups[source] = { ...original, tabs, selectedPath: original.selectedPath === tab.path
          ? tabs[0]?.path ?? null : original.selectedPath };
      }
      publish(prune({ layout, groups, activeId: destination }));
      return destination;
    },
    resize(id: string, ratio: number) { publish({ ...state, layout: resizeSplitPane(state.layout, id, ratio) }); },
    restore(tabs: WorkspaceTab[], value?: unknown) {
      const saved = parseEditorPaneSession(value);
      if (!saved) {
        publish({ layout: { type: 'pane', paneId: first.id }, activeId: first.id,
          groups: { [first.id]: { ...first, tabs, selectedPath: tabs[0]?.path ?? null } } });
        return;
      }
      const documents = new Map(tabs.map(t => [t.path, t]));
      const groups: Record<string, EditorPaneGroup> = {};
      const used = new Set<string>();
      for (const [id, group] of Object.entries(saved.groups)) {
        const restored = group.paths.flatMap(path => {
          const tab = documents.get(path); if (!tab) return []; used.add(path); return [tab];
        });
        groups[id] = { id, tabs: restored, selectedPath: restored.some(t => t.path === group.selectedPath)
          ? group.selectedPath : restored[0]?.path ?? null,
          problemsOpen: group.problemsOpen ?? true, problemsRatio: group.problemsRatio ?? DEFAULT_WORKSPACE_PROBLEMS_RATIO };
      }
      const active = groups[saved.activeId]!;
      active.tabs.push(...tabs.filter(t => !used.has(t.path)));
      if (!active.selectedPath) active.selectedPath = active.tabs[0]?.path ?? null;
      const layout = pruneEditorPaneLayout(saved.layout, new Set(Object.values(groups).filter(g => g.tabs.length).map(g => g.id)));
      if (!layout) { this.restore(tabs); return; }
      publish(prune({ layout: saved.layout, groups, activeId: saved.activeId }));
    },
  };
}

export type EditorPaneStore = ReturnType<typeof createEditorPaneStore>;
