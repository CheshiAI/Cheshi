import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { EditorSessionMode } from '../../../../shared/editor-session';
import { createEditorPaneStore } from './editorPaneStore';
import { useEditorSession } from './useEditorSession';
import { useEditorUpdateResume } from './useEditorUpdateResume';
import { isTabDirty, type WorkspaceTab } from './workspaceEditorModel';
import { DEFAULT_WORKSPACE_PROBLEMS_RATIO } from './WorkspaceProblemsResizer';

export function useEditorPanes(options: {
  sessionMode?: EditorSessionMode;
  onSessionRestored?: () => void;
  onSelectedPathChange(path: string | null): void;
  onDirtyPathsChange?: (paths: string[]) => void;
}) {
  const [store] = useState(createEditorPaneStore);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [error, setError] = useState('');
  const problemsOpen = state.groups[state.activeId]?.problemsOpen ?? true;
  const problemsRatio = state.groups[state.activeId]?.problemsRatio ?? DEFAULT_WORKSPACE_PROBLEMS_RATIO;
  const setProblemsOpen = (value: boolean) => store.configure(store.getSnapshot().activeId, { problemsOpen: value });
  const setProblemsRatio = (value: number) => store.configure(store.getSnapshot().activeId, { problemsRatio: value });
  const key = `cheshi-editor-panes:${cheshiDesktop?.workspaceRoot ?? ''}`;
  const [savedLayout] = useState<unknown>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
  });
  const tabs = store.allTabs();
  const selectedPath = state.groups[state.activeId]?.selectedPath ?? null;
  const tabsRef = useRef(tabs);
  const selectedPathRef = useRef(selectedPath);
  tabsRef.current = tabs;
  selectedPathRef.current = selectedPath;
  const replaceTabs = useCallback((update: (current: WorkspaceTab[]) => WorkspaceTab[]) => {
    const next = update(store.allTabs());
    tabsRef.current = next;
    store.restore(next, savedLayout);
  }, [store, savedLayout]);
  const selectPath = useCallback((path: string | null) => {
    const current = store.getSnapshot();
    // A pane session retains its own selected tab; old single-pane sessions use this path.
    if (Object.keys(current.groups).length === 1 && current.groups[current.activeId]?.tabs.some(t => t.path === path)) {
      store.select(current.activeId, path);
    }
  }, [store]);
  const ready = useEditorSession({ mode: options.sessionMode ?? 'restore', tabs, selectedPath,
    nextTabGeneration: store.nextGeneration, replaceTabs, selectPath,
    onSessionRestored: () => options.onSessionRestored?.(), onError: setError });
  const draftsPreserved = useEditorUpdateResume({ tabsRef, selectedPathRef,
    nextTabGeneration: store.nextGeneration, savingRef: store.saving, loading: !ready,
    applyingEdit: false, problemsOpen, problemsRatio, replaceTabs, selectPath, setProblemsOpen, setProblemsRatio,
    captureLayout: store.snapshot, restoreLayout: value => store.restore(tabsRef.current, value ?? savedLayout),
    isBusy: store.isBusy });
  const layoutSnapshot = JSON.stringify(store.snapshot());
  useEffect(() => {
    if (!ready || options.sessionMode === 'blocked') return;
    try { localStorage.setItem(key, layoutSnapshot); } catch { /* Session files still preserve open documents. */ }
  }, [ready, key, layoutSnapshot, options.sessionMode]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!store.allTabs().some(isTabDirty) || draftsPreserved()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [store, draftsPreserved]);
  useEffect(() => options.onSelectedPathChange(selectedPath), [selectedPath, options.onSelectedPathChange]);
  const dirtyKey = tabs.filter(isTabDirty).map(tab => tab.path).sort().join('\0');
  useEffect(() => options.onDirtyPathsChange?.(dirtyKey ? dirtyKey.split('\0') : []), [dirtyKey, options.onDirtyPathsChange]);
  return { store, state, ready, error, setError };
}
