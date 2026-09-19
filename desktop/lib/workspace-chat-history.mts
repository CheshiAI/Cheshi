import { createWorkspaceCodexAccounts } from './workspace-codex-accounts.mts';
import { ChatHistorySearch } from './chat-history-search.mts';
import { ChatHistoryRecall } from './chat-history-recall.mts';
import { createHistoryRecallEvaluator } from './chat-history-recall-model.mts';
import { createWorkspaceHistoryMcp } from './workspace-history-mcp.mts';

/** Connect the workspace's account-aware history reader to the local recall tools. */
export function createWorkspaceChatHistory(options: Omit<Parameters<typeof createWorkspaceCodexAccounts>[0], 'historyMcp'> & {
  historyDirectory: string;
  getKey?: () => string | null;
}) {
  // Account clients are lazy: the MCP callback runs only after all services below exist.
  const accounts = createWorkspaceCodexAccounts({ ...options, historyMcp: command => mcp.prepareCommand(command) });
  const search = new ChatHistorySearch({ directory: options.historyDirectory, cwd: options.cwd,
    source: { list: () => accounts.conversations.list(), read: (id, profileId) => profileId
      ? accounts.conversations.request(profileId, 'thread/read', { threadId: id, includeTurns: true })
      : accounts.conversations.read!(id, 'thread/read', { includeTurns: true }) } });
  const mcp = createWorkspaceHistoryMcp(new ChatHistoryRecall({
    history: search, evaluate: createHistoryRecallEvaluator({ getKey: () => options.getKey?.() ?? null }),
  }));
  return { accounts, search, mcp };
}
