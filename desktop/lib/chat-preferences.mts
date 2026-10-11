import type { ChatCollaborationMode } from './codex-chat-types.mts';
import { DEFAULT_PERMISSION_MODE_ID } from './codex-chat-permissions.mts';
import { recordValue } from './codex-service-utils.mts';

export interface ChatPreferences {
  permissionModeId: string;
  collaborationMode: ChatCollaborationMode;
}

export interface ChatPreferenceStore {
  read(): ChatPreferences;
  write(update: Partial<ChatPreferences>): void;
}

export function chatPreferences(value: unknown): ChatPreferences {
  const saved = recordValue(value);
  return {
    permissionModeId: typeof saved?.permissionModeId === 'string' && saved.permissionModeId.trim()
      ? saved.permissionModeId : DEFAULT_PERMISSION_MODE_ID,
    collaborationMode: saved?.collaborationMode === 'plan' ? 'plan' : 'default',
  };
}
