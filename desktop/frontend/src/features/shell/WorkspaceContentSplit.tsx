import { useCallback, useRef, useState, type ReactNode } from 'react';
import { SplitPaneLayout } from '../../shared/ui/SplitPaneLayout';
import { WorkspaceSplitRatioContext } from '../../shared/ui/workspaceSplitRatioContext';
import styles from './WorkspaceContentSplit.module.css';

export function WorkspaceContentSplit({ editorOpen, editor, children }: {
  editorOpen: boolean;
  editor: ReactNode;
  children: ReactNode;
}) {
  const [ratio, setRatio] = useState(0.5);
  const resized = useRef(false);
  const restore = useCallback((savedRatio: number) => {
    if (!resized.current) setRatio(savedRatio);
  }, []);
  return <WorkspaceSplitRatioContext.Provider value={{ ratio, restore }}><SplitPaneLayout
    layout={{ type: 'split', id: 'workspace-content', axis: 'columns', ratio,
      first: { type: 'pane', paneId: 'editor' }, second: { type: 'pane', paneId: 'page' } }}
    collapsedPane={editorOpen ? undefined : 'first'}
    onResizeSplit={(_id, nextRatio) => { resized.current = true; setRatio(nextRatio); }}
    resizeLabel="Resize file editor and page"
    renderPane={paneId => <div className={styles.pane}>
      {paneId === 'editor' ? editor : children}
    </div>}
  /></WorkspaceSplitRatioContext.Provider>;
}
