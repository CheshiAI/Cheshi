import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SplitPaneLayout } from '../../shared/ui/SplitPaneLayout';
import type { SplitLayoutNode } from '../../shared/ui/splitPaneModel';
import styles from './WorkspaceEditorSplit.module.css';

type LayoutMode = 'primary' | 'split' | 'editor' | 'page';

export function workspaceEditorLayout(mode: LayoutMode, ratio: number): SplitLayoutNode {
  if (mode === 'primary') return { type: 'pane', paneId: mode };
  return { type: 'split', id: 'workspace-editor', axis: 'columns', ratio,
    first: { type: 'pane', paneId: 'editor' }, second: { type: 'pane', paneId: 'primary' } };
}

function PaneHost({ host }: { host: HTMLDivElement }) {
  const mountRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    mountRef.current?.append(host);
    return () => { host.remove(); };
  }, [host]);
  return <div className={styles.mount} ref={mountRef} />;
}

/** Portals preserve page and editor state when the split tree changes shape. */
export function WorkspaceEditorSplit({ mode, children, editor }: {
  mode: LayoutMode;
  children: ReactNode;
  editor: ReactNode;
}) {
  const [hosts] = useState(() => ({ primary: document.createElement('div'), editor: document.createElement('div') }));
  const [ratio, setRatio] = useState(0.5);
  useLayoutEffect(() => {
    hosts.primary.className = styles.host ?? '';
    hosts.editor.className = styles.host ?? '';
  }, [hosts]);
  useEffect(() => {
    if (mode === 'primary') setRatio(0.5);
  }, [mode]);
  return (
    <div className={styles.root}>
      <SplitPaneLayout layout={workspaceEditorLayout(mode, ratio)} resizeLabel="Resize page and editor"
        collapsedPane={mode === 'editor' ? 'second' : mode === 'page' ? 'first' : null}
        onResizeSplit={(_id, nextRatio) => setRatio(nextRatio)}
        renderPane={id => <PaneHost host={id === 'editor' ? hosts.editor : hosts.primary} />} />
      {createPortal(children, hosts.primary, 'workspace-primary')}
      {createPortal(editor, hosts.editor, 'workspace-editor')}
    </div>
  );
}
