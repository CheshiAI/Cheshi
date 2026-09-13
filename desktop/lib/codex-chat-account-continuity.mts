import type { CodexChatService } from './codex-chat-service.mts';
import type { CodexChatClient, JsonObject } from './codex-chat-types.mts';
import type { CodexConversationAgents } from './codex-conversation-agents.mts';

export interface CodexConversationDeletion {
  profileId: string;
  threadId: string;
  threadIds: string[];
}

export interface CodexConversationAccess {
  agents?: Pick<CodexConversationAgents, 'read' | 'descendants' | 'assertWritable'>;
  list(): Promise<{ sessions: JsonObject[] }>;
  resolve(threadId: string, client: CodexChatClient): Promise<string>;
  assertWritable?(threadId: string): Promise<void>;
  takeLoaded?(threadId: string, client: CodexChatClient): boolean;
  read?(threadId: string, method: 'thread/read' | 'thread/goal/get', params?: JsonObject): Promise<unknown>;
  locations(threadId: string): Promise<Array<{ profileId: string; threadId: string }>>;
  deletionProgress?(threadId: string): Promise<CodexConversationDeletion[]>;
  confirmDeletion?(threadId: string, deletion: CodexConversationDeletion): Promise<void>;
  request(profileId: string, method: string, params?: unknown): Promise<unknown>;
  forget(threadId: string): Promise<void>;
}

/** Retain user choices and the viewed history while retiring all transport state. */
export function preserveCodexConversation(service: CodexChatService): () => void {
  const values = {
    viewedThreadId: service.viewedThreadId,
    viewedThreadIsSubagent: service.viewedThreadIsSubagent,
    selectedModel: service.selectedModel,
    selectedReasoningEffort: service.selectedReasoningEffort,
    selectedServiceTier: service.selectedServiceTier,
    selectedCollaborationMode: service.selectedCollaborationMode,
    selectedPermissionModeId: service.selectedPermissionModeId,
    permissionModesLoaded: service.permissionModesLoaded,
  };
  const skills = new Map(service.availableSkills);
  const permissions = new Map(service.permissionModes);
  return () => {
    Object.assign(service, values);
    service.availableSkills = skills;
    service.permissionModes = permissions;
    service.emit({ type: 'sessions-changed' });
  };
}
