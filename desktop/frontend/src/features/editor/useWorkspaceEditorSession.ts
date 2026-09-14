import { useContext, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import type { WorkspaceTab } from './workspaceEditorModel';
import { captureWorkspaceEditorSession, restoreWorkspaceEditorSession } from './workspaceEditorSession';
import { WorkspaceSplitRatioContext } from '../../shared/ui/workspaceSplitRatioContext';

export function useWorkspaceEditorSession(options: {
  tabs: readonly WorkspaceTab[];
  selectedPath: string | null;
  tabsRef: MutableRefObject<WorkspaceTab[]>;
  selectedPathRef: MutableRefObject<string | null>;
  nextTabGeneration: MutableRefObject<number>;
  replaceTabs(update: (tabs: WorkspaceTab[]) => WorkspaceTab[]): void;
  selectPath(path: string | null): void;
  onError(message: string): void;
}) {
  const split = useContext(WorkspaceSplitRatioContext);
  const splitRef = useRef(split);
  splitRef.current = split;
  const latest = useRef(options);
  latest.current = options;
  const [ready, setReady] = useState(false);
  const alive = useRef(false);
  const pathsKey = JSON.stringify(options.tabs.map(tab => tab.path));

  useEffect(() => {
    const api = cheshiDesktop?.editorSession;
    if (!api || !cheshiDesktop?.readWorkspaceFile) return;
    let cancelled = false;
    alive.current = true;
    const initialTabs = latest.current.tabsRef.current;
    const initialPath = latest.current.selectedPathRef.current;
    void api.read().then(async session => {
      if (cancelled) return;
      if (session) {
        const restored = await restoreWorkspaceEditorSession(session, cheshiDesktop!.readWorkspaceFile,
          () => ++latest.current.nextTabGeneration.current);
        if (cancelled) return;
        splitRef.current?.restore(session.splitRatio ?? 0.5);
        const current = latest.current;
        // A late startup response must not undo user navigation or update recovery.
        if (current.tabsRef.current === initialTabs && current.selectedPathRef.current === initialPath) {
          current.replaceTabs(() => restored.tabs);
          current.selectPath(restored.selectedPath);
        }
      }
      setReady(true);
    }).catch(reason => {
      if (!cancelled) latest.current.onError(`Could not restore editor tabs: ${errorMessage(reason)}`);
    });
    return () => { cancelled = true; alive.current = false; };
  }, []);

  useEffect(() => {
    const api = cheshiDesktop?.editorSession;
    if (!ready || !api) return;
    const current = latest.current;
    const session = captureWorkspaceEditorSession(current.tabsRef.current, current.selectedPathRef.current);
    if (splitRef.current) session.splitRatio = splitRef.current.ratio;
    void api.write(session).catch(reason => {
      if (alive.current) latest.current.onError(`Could not save editor tabs: ${errorMessage(reason)}`);
    });
  }, [ready, pathsKey, options.selectedPath, split?.ratio]);
}
