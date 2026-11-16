import { createWorkspaceCodexAccounts } from './workspace-codex-accounts.mts';
import { ChatHistorySearch } from './chat-history-search.mts';

/** Connect account-aware saved conversations to the session list's local search. */
export function createWorkspaceChatHistory(options: Parameters<typeof createWorkspaceCodexAccounts>[0] & {
  historyDirectory: string;
}) {
  const accounts = createWorkspaceCodexAccounts(options);
  const search = new ChatHistorySearch({ directory: options.historyDirectory, cwd: options.cwd,
    source: { list: () => accounts.conversations.list(), read: (id, profileId) => profileId
      ? accounts.conversations.request(profileId, 'thread/read', { threadId: id, includeTurns: true })
      : accounts.conversations.read!(id, 'thread/read', { includeTurns: true }) } });
  return { accounts, search };
}
