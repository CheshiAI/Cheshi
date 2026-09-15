import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { EditorSessionMode } from '../../../../shared/editor-session';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { WorkspaceTab } from './workspaceEditorModel';
import { captureEditorSession, restoreEditorSession } from './workspaceEditorSession';

export function useEditorSession(options: {
  mode: EditorSessionMode;
  tabs: WorkspaceTab[];
  selectedPath: string | null;
  nextTabGeneration: MutableRefObject<number>;
  replaceTabs(update: (tabs: WorkspaceTab[]) => WorkspaceTab[]): void;
  selectPath(path: string | null): void;
  onSessionRestored(): void;
  onError(message: string): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [ready, setReady] = useState(false);
  const [writable, setWritable] = useState(false);
  useEffect(() => {
    if (options.mode === 'waiting') return;
    if (options.mode === 'blocked') { setReady(true); return; }
    let disposed = false;
    const api = cheshiDesktop;
    void (async () => {
      try {
        if (options.mode === 'restore' && api?.editorSession && api.readWorkspaceFile) {
          const saved = await api.editorSession.read();
          if (disposed) return;
          if (saved) {
            const restored = await restoreEditorSession(saved, api.readWorkspaceFile,
              () => ++latest.current.nextTabGeneration.current);
            if (disposed) return;
            latest.current.replaceTabs(() => restored.tabs);
            latest.current.selectPath(restored.selectedPath);
            if (restored.tabs.length) latest.current.onSessionRestored();
          }
        } else if (options.mode === 'preserve' && latest.current.tabs.length) {
          latest.current.onSessionRestored();
        }
        if (!disposed) setWritable(true);
      } catch (error) {
        if (!disposed) latest.current.onError(`File session recovery: ${String(error)}`);
      } finally { if (!disposed) setReady(true); }
    })();
    return () => { disposed = true; };
  }, [options.mode]);

  const snapshot = JSON.stringify(captureEditorSession(options.tabs, options.selectedPath));
  useEffect(() => {
    if (!ready || !writable || !cheshiDesktop?.editorSession) return;
    void cheshiDesktop.editorSession.save(JSON.parse(snapshot)).catch((error: unknown) => {
      latest.current.onError(`File session save: ${String(error)}`);
    });
  }, [ready, writable, snapshot]);
  return ready;
}
