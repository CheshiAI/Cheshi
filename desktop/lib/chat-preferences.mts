import type { ChatCollaborationMode } from './codex-chat-types.mts';
import { DEFAULT_PERMISSION_MODE_ID } from './codex-chat-permissions.mts';
import { recordValue } from './codex-service-utils.mts';

export interface ChatPreferences {
  permissionModeId: string;
  collaborationMode: ChatCollaborationMode;
  model?: string;
  reasoningEffort?: string;
  // Missing means the model default; null is an explicit Standard selection.
  serviceTier?: string | null;
}

export type ChatModelPreferences = Pick<ChatPreferences, 'model' | 'reasoningEffort' | 'serviceTier'>;

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
    ...(typeof saved?.model === 'string' && saved.model.trim() ? { model: saved.model } : {}),
    ...(typeof saved?.reasoningEffort === 'string' && saved.reasoningEffort.trim()
      ? { reasoningEffort: saved.reasoningEffort } : {}),
    ...(saved?.serviceTier === null || (typeof saved?.serviceTier === 'string' && saved.serviceTier.trim())
      ? { serviceTier: saved.serviceTier } : {}),
  };
}
