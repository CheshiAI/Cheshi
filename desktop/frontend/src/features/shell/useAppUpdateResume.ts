import { useEffect, useRef, useState } from 'react';
import type { EditorSessionMode } from '../../../../shared/editor-session';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { WorkspaceView } from '../navigation/Sidebar';
import { resumeRecord, updateResumeCoordinator } from './updateWorkspaceResume';

const restorableViews: readonly WorkspaceView[] = ['chat', 'notes', 'blank', 'codegraph', 'editor', 'git', 'plugins', 'terminal', 'showcase', 'autopilot'];
let initialSnapshot: Promise<unknown> | undefined;

export function useAppUpdateResume(options: {
  activeView: WorkspaceView;
  rightSidebarOpen: boolean;
  blockedReason: string | null;
  setActiveView(view: WorkspaceView): void;
  setRightSidebarOpen(open: boolean): void;
}) {
  const current = useRef(options);
  current.current = options;
  const [editorSessionMode, setEditorSessionMode] = useState<EditorSessionMode>('waiting');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const api = cheshiDesktop;
    if (!api?.getUpdateResume || !api.saveUpdateResume || !api.onPrepareAppUpdate
      || !api.acknowledgeAppUpdate || !api.onAppUpdateCommitted || !api.onAppUpdatePreparationCancelled || !api.clearUpdateResume) { setEditorSessionMode('restore'); return; }
    let disposed = false;
    let restoring = true;
    let preparing = false;
    let recoveryFailed = false;
    const unregister = updateResumeCoordinator.register('shell', {
      capture() {
        if (current.current.blockedReason) throw new Error(current.current.blockedReason);
        return { activeView: current.current.activeView, rightSidebarOpen: current.current.rightSidebarOpen };
      },
      restore(value) {
        const record = resumeRecord(value);
        if (!record || typeof record.rightSidebarOpen !== 'boolean' || typeof record.activeView !== 'string') {
          throw new Error('The saved workspace layout is invalid.');
        }
        const view = restorableViews.find((entry) => entry === record.activeView) ?? 'chat';
        current.current.setActiveView(view);
        current.current.setRightSidebarOpen(record.rightSidebarOpen);
      },
    });
    setBusy(true);
    initialSnapshot ??= api.getUpdateResume();
    void initialSnapshot.then(async (snapshot) => {
      if (disposed) return;
      await updateResumeCoordinator.restore(snapshot, api.workspaceRoot);
      if (!disposed && snapshot !== null) await api.clearUpdateResume!();
      if (!disposed) {
        const sections = resumeRecord(resumeRecord(snapshot)?.sections);
        setEditorSessionMode(sections && Object.hasOwn(sections, 'editor') ? 'preserve' : 'restore');
      }
    }).catch((reason: unknown) => {
      recoveryFailed = true;
      if (!disposed) setEditorSessionMode('blocked');
      if (!disposed) setError(`Workspace recovery: ${reason instanceof Error ? reason.message : String(reason)}`);
    }).finally(() => { restoring = false; if (!disposed) setBusy(false); });
    const cancel = () => {
      updateResumeCoordinator.cancel();
      if (!disposed) setBusy(false);
    };
    const unsubscribe = api.onPrepareAppUpdate((requestId) => {
      if (recoveryFailed) {
        void api.acknowledgeAppUpdate!(requestId, 'Resolve the saved workspace recovery error before updating again.');
        return;
      }
      if (preparing || restoring) {
        void api.acknowledgeAppUpdate!(requestId, 'Wait for workspace recovery or preparation to finish.');
        return;
      }
      preparing = true;
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          await updateResumeCoordinator.prepare(api.workspaceRoot, api.saveUpdateResume!);
          await api.acknowledgeAppUpdate!(requestId, null);
        } catch (reason) {
          cancel();
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          await api.acknowledgeAppUpdate!(requestId, message);
        } finally { preparing = false; }
      })().catch((reason: unknown) => {
        cancel();
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    });
    const unsubscribeCommitted = api.onAppUpdateCommitted((requestId) => {
      let failure: string | null = null;
      try { updateResumeCoordinator.commit(); }
      catch (reason) { failure = reason instanceof Error ? reason.message : String(reason); cancel(); }
      void api.acknowledgeAppUpdate!(requestId, failure).catch((reason: unknown) => {
        cancel();
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    });
    const unsubscribeCancelled = api.onAppUpdatePreparationCancelled(cancel);
    return () => { disposed = true; unregister(); unsubscribe(); unsubscribeCommitted(); unsubscribeCancelled(); updateResumeCoordinator.cancel(); };
  }, []);
  return { busy, error, editorSessionMode };
}
