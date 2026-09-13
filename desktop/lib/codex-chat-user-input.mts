import { randomUUID } from 'node:crypto';
import { chatUserInputResponse, inputRecord } from '../shared/chat-user-input.ts';
import type { ChatUserInputRequest } from '../shared/chat-user-input.ts';
import type { CodexChatClient, JsonObject } from './codex-chat-types.mts';
import { userInputRequest, userInputResult } from './codex-chat-user-input-schema.mts';

type PendingInput = { request: ChatUserInputRequest; serverId: string | number; responding: boolean };
export class CodexChatUserInputs {
  private readonly pending = new Map<string, PendingInput>();
  private readonly client: CodexChatClient;
  private readonly emit: (event: JsonObject) => void;
  constructor(client: CodexChatClient, emit: (event: JsonObject) => void) { this.client = client; this.emit = emit; }
  list(): ChatUserInputRequest[] { return [...this.pending.values()].map(({ request }) => request); }
  handle(value: JsonObject): boolean {
    const method = value.method;
    if (method !== 'item/tool/requestUserInput' && method !== 'mcpServer/elicitation/request') return false;
    const params = inputRecord(value.params);
    const serverId = value.id;
    if (!params || (typeof serverId !== 'number' && typeof serverId !== 'string')) return true;
    if ([...this.pending.values()].some(entry => entry.serverId === serverId)) return true;
    let request: ChatUserInputRequest;
    try { request = userInputRequest(`input-${randomUUID()}`, method, params); }
    catch {
      // Invalid requests are resolved instead of leaving the agent waiting forever.
      void this.client.respond(serverId, method === 'item/tool/requestUserInput' ? { answers: {} } : { action: 'cancel' }).catch(() => {});
      this.emit({ type: 'error', message: 'An input request could not be displayed and was cancelled.', ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}) });
      return true;
    }
    this.pending.set(request.id, { request, serverId, responding: false });
    this.emit({ type: 'user-input-requested', request });
    return true;
  }
  async respond(id: unknown, value: unknown): Promise<{ requestId: string }> {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('The input request id is invalid.');
    const entry = this.pending.get(id);
    if (!entry || entry.responding) throw new Error('The input request is no longer available.');
    const response = userInputResult(entry.request, chatUserInputResponse(value));
    entry.responding = true;
    try { await this.client.respond(entry.serverId, response); }
    catch (error) { entry.responding = false; throw error; }
    this.resolve(id);
    return { requestId: id };
  }
  resolve(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.emit({ type: 'user-input-resolved', requestId: id, threadId: entry.request.threadId });
  }
  serverResolved(params: JsonObject) {
    for (const [id, entry] of this.pending) {
      if (entry.serverId === params.requestId && entry.request.threadId === params.threadId) this.resolve(id);
    }
  }
  clear(threadId?: string | null, turnId?: string | null) {
    for (const [id, entry] of this.pending) {
      if ((!threadId || entry.request.threadId === threadId) && (!turnId || entry.request.turnId === null || entry.request.turnId === turnId)) this.resolve(id);
    }
  }
  async cancel(threadId: string) {
    const entries = [...this.pending.entries()].filter(([, entry]) => entry.request.threadId === threadId);
    await Promise.all(entries.map(async ([id, entry]) => {
      if (entry.responding) return;
      await this.respond(id, { action: 'cancel' });
    }));
  }
}
