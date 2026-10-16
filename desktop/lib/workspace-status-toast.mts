import { isStatusToastMessage } from '../shared/status-toast.ts';
import { WORKSPACE_HOST_CHANNEL } from '../shared/workspace-host.ts';

interface ToastTarget {
  isDestroyed(): boolean;
  send(channel: string, message: unknown): void;
}

/** Native child views cover the host DOM, so render host notifications in the active child. */
export function forwardWorkspaceStatusToast(sender: unknown, host: unknown, target: ToastTarget | undefined, message: unknown): boolean {
  if (sender !== host || !isStatusToastMessage(message) || !target || target.isDestroyed()) return false;
  target.send(`${WORKSPACE_HOST_CHANNEL}:status-toast`, message);
  return true;
}
