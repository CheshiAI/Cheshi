import { createLunaReranker } from './rerank.mts';
import type { AgentFlashMemory } from './agent-memory.mts';
import { registerFlashMemoryIpc } from './ipc.mts';
import type { CodexConversationAccess } from '../codex-chat-account-continuity.mts';
import type { ChatHistorySearch } from '../chat-history-search.mts';
import type { JsonObject } from '../codex-chat-types.mts';
import type { CodexAccountsSnapshot } from '../../shared/codex-accounts.ts';
import { codexWorkspaceActivity } from '../codex-workspace-activity.mts';
import { workspaceChatServiceOptions } from '../workspace-chat-service-options.mts';
import type { CodexChatClient } from '../codex-chat-types.mts';
import { createLunaSummary } from './summary.mts';
import { acquireFlashHost } from './runtime.mts';
import { FlashSessionMemory } from './session-memory.mts';

/** Foreground SESSION adapter; the existing list search keeps its own index and API. */
export function createWorkspaceSessionMemory(workspace: string, userData: string,
  conversations: CodexConversationAccess, listSearch: Pick<ChatHistorySearch, 'search' | 'remove' | 'changed'>,
  createMcpProbeClient: () => CodexChatClient & { stop(): Promise<void> }, ipc: Parameters<typeof registerFlashMemoryIpc>[0], assertSender: Parameters<typeof registerFlashMemoryIpc>[1], agents?: AgentFlashMemory) {
  const rerank = createLunaReranker(createMcpProbeClient, workspace);
  const summarize = createLunaSummary(createMcpProbeClient, workspace);
  const memory = new FlashSessionMemory({ workspace, host: acquireFlashHost(userData), summarize, rerank,
    source: { list: () => conversations.list(), read: (id, profileId) => {
      if (!profileId) throw new Error('The session account is unavailable.');
      return conversations.request(profileId, 'thread/read', { threadId: id, includeTurns: true });
    } }, blocked: () => codexWorkspaceActivity(workspace).deleting,
    onError: code => process.stderr.write(`[cheshi] flash-sync ${code}\n`),
  });
  const unregister = agents?.register(workspace, { memory, summarize, rerank, verifyCandidates: (matches, signal) => memory.verifyCandidates(matches, signal), authenticated: id => memory.hasAccount(id), original: target => memory.original(target) });
  registerFlashMemoryIpc(ipc, assertSender, memory, target => agents ? agents.original(workspace, target) : memory.original(target));
  return {
    memory,
    dispose: async () => { unregister?.(); await memory.dispose(); },
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
