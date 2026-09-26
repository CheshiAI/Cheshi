import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cheshiDesktop } from '../../cheshiDesktop';
import { SplitPaneLayout } from '../../shared/ui/SplitPaneLayout';
import type { SplitLayoutNode, SplitPaneDirection } from '../../shared/ui/splitPaneModel';
import { WorkspaceLayoutContext, WorkspacePaneVisibilityContext } from '../shell/WorkspaceLayoutControls';
import { WorkspaceEditorPane, type WorkspaceEditorProps } from './WorkspaceEditorPane';
import { useEditorPanes } from './useEditorPanes';
import { EditorPaneHost } from './EditorPaneHost';
import { droppedWorkspacePaths, readEditorTabTransfer } from './editorFileDrop';
import { normalizeWorkspaceEditorContent } from './workspaceFileLoad';
import type { WorkspaceEditorTarget } from './useWorkspaceEditorController';
import type { WorkspaceTab } from './workspaceEditorModel';
import styles from './EditorPanes.module.css';
import './workspace-editor.css';

export type { WorkspaceEditorMutation, WorkspaceEditorTarget } from './useWorkspaceEditorController';
const ignoreSelection = () => {};

/** Pane controllers remain mounted in stable portals as the split tree changes. */
export function WorkspaceEditor(props: WorkspaceEditorProps) {
  const visible = useContext(WorkspacePaneVisibilityContext);
  const workspaceLayout = useContext(WorkspaceLayoutContext);
  const active = props.active && visible;
  const { store, state, ready, error, setError } = useEditorPanes(props);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const expandedWorkspace = useRef(false);
  const canMaximize = Object.keys(state.groups).length > 1;
  const maximized = canMaximize && maximizedId && state.groups[maximizedId] ? maximizedId : null;
  const shownLayout: SplitLayoutNode = maximized ? { type: 'pane', paneId: maximized } : state.layout;
  // Adding/removing a split reveals its result; restoring never modifies saved ratios or tab groups.
  useEffect(() => { setMaximizedId(null); }, [state.layout]);
  useEffect(() => {
    if (!expandedWorkspace.current) return;
    if (workspaceLayout?.maximized !== 'editor') {
      expandedWorkspace.current = false;
      setMaximizedId(null);
    } else if (!maximized) {
      expandedWorkspace.current = false;
      workspaceLayout.maximize('editor');
    }
  }, [maximized, workspaceLayout]);
  const toggleMaximized = (id: string) => {
    store.activate(id);
    setMaximizedId(current => current === id ? null : id);
    if (maximized !== id && workspaceLayout?.canMaximize && workspaceLayout.maximized !== 'editor') {
      expandedWorkspace.current = true;
      workspaceLayout.maximize('editor');
    }
  };
  const [hosts] = useState(() => new Map<string, HTMLDivElement>());
  const detachedFocus = useRef<HTMLElement | null>(null);
  const onDetach = useCallback((element: HTMLElement) => { detachedFocus.current = element; }, []);
  const [routedTarget, setRoutedTarget] = useState<{ id: string; target: WorkspaceEditorTarget } | null>(null);
  useEffect(() => {
    if (props.target && active && ready) setRoutedTarget({ id: store.getSnapshot().activeId, target: props.target });
  }, [props.target, active, ready, store]);
  for (const id of Object.keys(state.groups)) {
    if (!hosts.has(id)) {
      const host = document.createElement('div');
      host.className = styles.host ?? '';
      hosts.set(id, host);
    }
    hosts.get(id)!.dataset.active = String(id === state.activeId);
  }
  useEffect(() => {
    for (const id of hosts.keys()) if (!state.groups[id]) hosts.delete(id);
  }, [hosts, state.groups]);
  useLayoutEffect(() => {
    const previous = detachedFocus.current;
    detachedFocus.current = null;
    if (previous?.isConnected && document.activeElement === document.body) previous.focus({ preventScroll: true });
  });
  const dropSequence = useRef(0);
  useEffect(() => () => { dropSequence.current++; }, []);
  useEffect(() => { if (!active) dropSequence.current++; }, [active]);
  const receive = useCallback((data: DataTransfer, target: string, direction: SplitPaneDirection | null) => {
    const transfer = readEditorTabTransfer(data);
    const sequence = ++dropSequence.current;
    if (transfer) {
      const tab = store.getSnapshot().groups[transfer.paneId]?.tabs.find(t => t.path === transfer.path);
      if (tab) store.place(tab, target, direction, transfer.paneId);
      return;
    }
    if (!cheshiDesktop) return;
    const paths = droppedWorkspacePaths(data, cheshiDesktop.workspaceRoot);
    if (!paths.length) return;
    const busyId = `drop-${sequence}`;
    store.setBusy(busyId, true);
    void (async () => {
      let destination = target;
      for (const path of paths) {
        let tab = store.allTabs().find(t => t.path === path);
        if (!tab) {
          const response = await cheshiDesktop!.readWorkspaceFile(path);
          const content = normalizeWorkspaceEditorContent(response.content ?? '');
          tab = { path, file: response.file, savedContent: content, draftContent: content,
            previewDataUrl: response.dataUrl, sourceExcerpt: null, conflictMessage: null,
            loadGeneration: ++store.nextGeneration.current } satisfies WorkspaceTab;
        }
        if (sequence !== dropSequence.current || !store.getSnapshot().groups[destination]) return;
        const placed = store.place(tab, destination, direction);
        if (!placed) return;
        destination = placed;
        direction = null;
      }
      setError('');
    })().catch((reason: unknown) => {
      if (sequence === dropSequence.current) setError(String(reason));
    }).finally(() => store.setBusy(busyId, false));
  }, [store, setError]);
  return <div className={styles.root} style={!active ? { display: 'none' } : undefined}>
    {error && <p role="alert">{error}</p>}
    <SplitPaneLayout layout={shownLayout} onResizeSplit={store.resize} resizeLabel="Resize editor panes"
      renderPane={id => <EditorPaneHost host={hosts.get(id)!} id={id} onDetach={onDetach} onDrop={receive} />} />
    <div hidden inert>
      {maximized && Object.keys(state.groups).filter(id => id !== maximized).map(id =>
        <EditorPaneHost key={id} host={hosts.get(id)!} id={id} onDetach={onDetach} onDrop={receive} />)}
    </div>
    {Object.keys(state.groups).map(id => createPortal(
      <WorkspaceEditorPane {...props} active={active} pane={{ store, id, ready }}
        maximizeControl={canMaximize ? {
          enabled: true,
          maximized: maximized === id,
          toggle: () => toggleMaximized(id),
        } : undefined}
        target={routedTarget?.id === id ? routedTarget.target : null}
        onSelectedPathChange={ignoreSelection} onDirtyPathsChange={undefined}
        onAllTabsClosed={() => {
          store.closeEmpty(id);
          if (store.allTabs().length === 0) props.onAllTabsClosed();
        }} />,
      hosts.get(id)!, id))}
  </div>;
}
