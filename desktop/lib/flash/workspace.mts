import { registerFlashMemoryIpc } from './ipc.mts';
import type { CodexConversationAccess } from '../codex-chat-account-continuity.mts';
import type { ChatHistorySearch } from '../chat-history-search.mts';
import type { JsonObject } from '../codex-chat-types.mts';
import type { CodexAccountsSnapshot } from '../../shared/codex-accounts.ts';
import { codexWorkspaceActivity } from '../codex-workspace-activity.mts';
import { workspaceChatServiceOptions } from '../workspace-chat-service-options.mts';
import type { CodexMcpProbeClient } from '../codex-mcp-probe.mts';
import { acquireFlashHost } from './runtime.mts';
import { FlashSessionMemory } from './session-memory.mts';

/** Foreground SESSION adapter; the existing list search keeps its own index and API. */
export function createWorkspaceSessionMemory(workspace: string, userData: string,
  conversations: CodexConversationAccess, listSearch: Pick<ChatHistorySearch, 'search' | 'remove' | 'changed'>,
  createMcpProbeClient: () => CodexMcpProbeClient, ipc: Parameters<typeof registerFlashMemoryIpc>[0], assertSender: Parameters<typeof registerFlashMemoryIpc>[1]) {
  const memory = new FlashSessionMemory({ workspace, host: acquireFlashHost(userData),
    source: { list: () => conversations.list(), read: (id, profileId) => {
      if (!profileId) throw new Error('The session account is unavailable.');
      return conversations.request(profileId, 'thread/read', { threadId: id, includeTurns: true });
    } }, blocked: () => codexWorkspaceActivity(workspace).deleting,
    onError: code => process.stderr.write(`[cheshi] flash-sync ${code}\n`),
  });
  registerFlashMemoryIpc(ipc, assertSender, memory);
  return {
    memory,
    serviceOptions: { ...workspaceChatServiceOptions(workspace, conversations, createMcpProbeClient), memory },
    historySearch: { search: (request: unknown) => listSearch.search(request), remove: async (ids: string[]) => {
      await Promise.all([listSearch.remove(ids), memory.remove(ids)]);
    } },
    changed: (event: JsonObject) => { listSearch.changed(event); memory.changed(event); },
    accounts: (snapshot: CodexAccountsSnapshot) => {
      memory.accounts(snapshot);
      listSearch.changed({ type: 'sessions-changed' });
    },
  };
}
