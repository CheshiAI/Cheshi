import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { CodexChatService } from './codex-chat-service.mts';
import type { CodexChatRelays } from './codex-chat-relay.mts';
import type { CodexChatSavedTurns } from './codex-chat-saved-turns.mts';
import type { ChatAttachment } from './codex-chat-types.mts';
import { chatRelayContextIds } from '../shared/chat-relay.ts';
import type { CodexChatSessionDeletion } from './codex-chat-session-deletion.mts';
import { CodexAppServerStoppedError } from './codex-app-server-client.mts';
import type { ChatHistorySearch } from './chat-history-search.mts';
import { AppleNotesService } from './apple-notes-service.mts';
import { registerAppleNotesIpc } from './apple-notes-ipc.mts';

type ChatIpcOptions = {
  ipc: Pick<IpcMain, 'handle'>;
  service(event: IpcMainInvokeEvent, contextId: unknown): CodexChatService;
  relays: CodexChatRelays;
  deletion?: CodexChatSessionDeletion;
  historySearch?: Pick<ChatHistorySearch, 'search' | 'remove'>;
  savedTurns: Pick<CodexChatSavedTurns, 'list' | 'save' | 'delete'>;
  assertSender(event: IpcMainInvokeEvent): void;
  beforeMessage?(): Promise<void>;
  prepareMessage(value: unknown): Promise<{ text: string; clientMessageId: string; skill: unknown; attachments: ChatAttachment[]; threadId?: string | null }>;
};

export function registerCodexChatIpc({ ipc, service, relays, deletion, savedTurns, historySearch, assertSender, prepareMessage, beforeMessage }: ChatIpcOptions) {
  registerAppleNotesIpc({ ipcMain: ipc, service: new AppleNotesService(), assertSender });
  const mutation = <T,>(event: IpcMainInvokeEvent, contextId: unknown, operation: () => Promise<T> | T) => {
    assertSender(event);
    const run = () => relays.mutation(event.sender.id, contextId, operation);
    return deletion ? deletion.mutation(run) : run();
  };
  ipc.handle('cheshi:search-codex-chat-history', (event, request, _contextId) => {
    assertSender(event);
    if (!historySearch) throw new Error('Session search is unavailable. Restart Cheshi.');
    return historySearch.search(request);
  });
  ipc.handle('cheshi:delete-codex-chat-session', async (event, sessionId, contextId) => {
    assertSender(event);
    if (!deletion) throw new Error('Conversation deletion is unavailable.');
    const result = await deletion.deleteSession(service(event, contextId), sessionId);
    try { await historySearch?.remove(result.threadIds); }
    catch {
      return { ...result, historySearchWarning: 'The conversation was deleted, but its local search index could not be removed. Retry chat search to clean up the index.' };
    }
    return result;
  });
  ipc.handle('cheshi:list-codex-chat-sessions', async (event, contextId) => {
    const selected = service(event, contextId);
    try {
      return await selected.listSessions();
    } catch (error) {
      // A destroyed renderer cannot consume its pending history read. Only an
      // intentional server stop is cancellation; live requests and failures reject.
      if (error instanceof CodexAppServerStoppedError && event.sender.isDestroyed()) return;
      throw error;
    }
  });
  ipc.handle('cheshi:list-codex-chat-agents', (event, contextId) => service(event, contextId).listAgents());
  ipc.handle('cheshi:read-codex-agent-details', (event, threadId, agentThreadIds, contextId) => {
    assertSender(event);
    return service(event, contextId).readAgentDetails(threadId, agentThreadIds);
  });
  ipc.handle('cheshi:list-codex-skills', (event, contextId) => service(event, contextId).listSkills());
  ipc.handle('cheshi:list-codex-models', (event, contextId) => service(event, contextId).listModels());
  ipc.handle('cheshi:list-codex-mcp-servers', (event, contextId) => service(event, contextId).listMcpServers());
  ipc.handle('cheshi:list-codex-permission-modes', (event, contextId) => service(event, contextId).listPermissionModes());
  ipc.handle('cheshi:get-codex-chat-status', (event, contextId) => service(event, contextId).getStatus());
  ipc.handle('cheshi:get-codex-chat-goal', (event, contextId) => service(event, contextId).getGoal());
  ipc.handle('cheshi:list-codex-chat-user-inputs', (event, contextId) => service(event, contextId).userInputs.list());
  ipc.handle('cheshi:respond-codex-chat-user-input', (event, requestId, response, contextId) => service(event, contextId).userInputs.respond(requestId, response));
  ipc.handle('cheshi:respond-codex-chat-approval', (event, approvalId, decision, contextId) => service(event, contextId).respondToApproval(approvalId, decision));
  ipc.handle('cheshi:set-codex-permission-mode', (event, modeId, contextId) => mutation(event, contextId, () => service(event, contextId).setPermissionMode(modeId)));
  ipc.handle('cheshi:set-codex-collaboration-mode', (event, mode, contextId) => mutation(event, contextId, () => service(event, contextId).setCollaborationMode(mode)));
  ipc.handle('cheshi:configure-codex-chat', (event, value, contextId) => mutation(event, contextId, () => service(event, contextId).configure(value)));
  ipc.handle('cheshi:set-codex-chat-goal', (event, objective, contextId) => mutation(event, contextId, () => service(event, contextId).setGoal(objective)));
  ipc.handle('cheshi:open-codex-chat-session', (event, sessionId, contextId) => mutation(event, contextId, () => service(event, contextId).openSession(sessionId)));
  ipc.handle('cheshi:open-codex-chat-agent', (event, agentThreadId, contextId) => mutation(event, contextId, () => service(event, contextId).openAgent(agentThreadId)));
  ipc.handle('cheshi:new-codex-chat-session', (event, contextId) => mutation(event, contextId, () => service(event, contextId).newSession()));
  ipc.handle('cheshi:fork-codex-chat-session', (event, contextId) => mutation(event, contextId, () => service(event, contextId).forkSession()));
  ipc.handle('cheshi:compact-codex-chat-session', (event, contextId) => mutation(event, contextId, () => service(event, contextId).compactSession()));
  ipc.handle('cheshi:review-codex-chat-session', (event, contextId) => mutation(event, contextId, () => service(event, contextId).reviewSession()));
  const messageOperation = (method: 'sendMessage' | 'steerMessage') => (event: IpcMainInvokeEvent, value: unknown, contextId: unknown) => {
    const run = () => mutation(event, contextId, async () => {
      let sending = false;
      try {
        const selected = service(event, contextId);
        const request = await prepareMessage(value);
        sending = true;
        return await selected[method](request.text, request.clientMessageId, request.skill, request.attachments, request.threadId);
      } catch (error) {
        return { sendFailure: !sending || (error instanceof Error && error.name === 'CodexMessageNotSent') ? 'failed' : 'unknown',
          message: error instanceof Error ? error.message : String(error) };
      }
    });
    return (async () => {
      try {
        assertSender(event);
        if (method === 'sendMessage') {
          service(event, contextId);
          await beforeMessage?.();
        }
        return await run();
      } catch (error) {
        return { sendFailure: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    })();
  };
  ipc.handle('cheshi:send-codex-chat-message', messageOperation('sendMessage'));
  ipc.handle('cheshi:steer-codex-chat-message', messageOperation('steerMessage'));
  ipc.handle('cheshi:cancel-codex-chat-response', (event, threadId, contextId) => {
    const selected = service(event, contextId);
    const relay = relays.get(event.sender.id);
    if (relay && (relay.status === 'running' || relay.status === 'stopping') && typeof contextId === 'string' && chatRelayContextIds(relay).includes(contextId)) {
      relays.stop(event.sender.id);
      return { requested: true };
    }
    return selected.cancelResponse(threadId);
  });
  ipc.handle('cheshi:start-codex-chat-relay', (event, request) => {
    assertSender(event);
    const start = () => relays.start(event.sender.id, request);
    return deletion ? deletion.mutation(start) : start();
  });
  ipc.handle('cheshi:stop-codex-chat-relay', (event) => { assertSender(event); return relays.stop(event.sender.id); });
  ipc.handle('cheshi:get-codex-chat-relay', (event) => { assertSender(event); return relays.get(event.sender.id); });
  ipc.handle('cheshi:list-codex-chat-relay-history', (event) => { assertSender(event); return relays.listHistory(event.sender.id); });
  ipc.handle('cheshi:delete-codex-chat-relay-history', (event, id) => { assertSender(event); return relays.deleteHistory(event.sender.id, id); });
  ipc.handle('cheshi:list-codex-saved-turns', (event) => { assertSender(event); return savedTurns.list(); });
  ipc.handle('cheshi:save-codex-turn', (event, input) => { assertSender(event); return savedTurns.save(input); });
  ipc.handle('cheshi:delete-codex-saved-turn', (event, id) => { assertSender(event); return savedTurns.delete(id); });
}
