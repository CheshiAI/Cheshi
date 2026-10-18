import { useEffect } from 'react';
import type { WorkspaceNavigationState } from '../../../../shared/workspace-host';
import { cheshiDesktop } from '../../cheshiDesktop';
import { useChatsSnapshot } from '../agent-chats/useChatsSnapshot';
import { WorkspaceStatusToasts } from './WorkspaceStatusToasts';
import { connectWorkspaceRailBlur } from './workspaceRailBlur';

/** Observe the existing shared Worker store without rerendering the whole shell. */
export function WorkspaceSurfaceReporter({ view, sidebarOpen, running, attention, homiesEnabled = false }: WorkspaceNavigationState) {
  useEffect(() => {
    return window.workspaceSurface?.onRailBlur ? connectWorkspaceRailBlur(window.workspaceSurface, document) : undefined;
  }, []);
  const { snapshot } = useChatsSnapshot(cheshiDesktop?.agentChats, false);
  const workers = new Set(snapshot.messages.filter(message =>
    ((message.sender === 'user' && message.taskId) || message.relatedTask)
    && (message.executionStatus ?? message.status) === 'running').map(message => message.taskId ?? message.relatedTask?.taskId));
  const workerAttention = snapshot.messages.some(message => message.goalProgress?.questions?.some(question => question.status === 'waiting')
    || (message.kind === 'permission_request' && message.permissionRequest?.status === 'pending'));
  const count = running + workers.size;
  useEffect(() => {
    window.workspaceSurface?.report({ homiesEnabled, view, sidebarOpen, running: count, attention: attention || workerAttention });
  }, [view, sidebarOpen, count, attention, workerAttention, homiesEnabled]);
  return <WorkspaceStatusToasts />;
}
