import { useCallback, useRef } from 'react';

interface WorkflowChatWorkspace {
  deletePending: boolean;
  paneIds: string[];
  controllers: Record<string, { state: { activeSessionId: string | null } }>;
  selectPane(paneId: string): void;
  openSession(threadId: string): Promise<boolean>;
}

/** Setup can finish after session-created has selected its live conversation. */
export function useWorkflowChatNavigation(workspace: WorkflowChatWorkspace, reveal: () => void) {
  const latest = useRef({ workspace, reveal });
  latest.current = { workspace, reveal };
  return useCallback(async (threadId: string): Promise<boolean> => {
    const { workspace: current, reveal: show } = latest.current;
    if (current.deletePending) return false;
    show();
    const pane = current.paneIds.find(id => current.controllers[id]?.state.activeSessionId === threadId);
    if (pane) {
      current.selectPane(pane);
      return true;
    }
    return current.openSession(threadId);
  }, []);
}
