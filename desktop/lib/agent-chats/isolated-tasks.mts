import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { parseChatsRequest, type AgentRoom } from '../../shared/agent-chats.ts';
import { isolatedMessageStatus, type IsolatedWork } from '../../shared/isolated-work.ts';
import { safeError, type PlatformChatContext, type PlatformChats } from '../agent-platform/chat-service.mts';
import type { ChatsStore } from './store.mts';

export function createIsolatedChatTasks(options: {
  store(): ChatsStore;
  platform?: PlatformChats;
  room(workspace: string, id: string): AgentRoom;
  assertMember(room: AgentRoom, id: string): void;
}) {
  const active = new Map<string, { controller: AbortController; flight: Promise<void> }>();
  const update = (id: string, patch: Partial<IsolatedWork>) => options.store().update(state => {
    const message = state.messages.find(m => m.id === id);
    if (!message?.isolated) throw new Error('Isolated task record disappeared.');
    message.isolated = { ...message.isolated, ...patch };
    message.status = isolatedMessageStatus(message.isolated.phase);
  });
  function context(room: AgentRoom, agentId: string, accountId: string, prompt: string): PlatformChatContext {
    return { workspace: room.workspace, engineId: room.engineId, agentId, accountId, prompt };
  }
  return {
    async request(workspaceRoot: string, value: unknown): Promise<void> {
      const request = parseChatsRequest(value), platform = options.platform;
      if (!platform) throw new Error('Restart the desktop app to enable isolated tasks.');
      if (!['isolated-submit', 'isolated-inspect', 'isolated-cancel', 'isolated-setup'].includes(request.action) || !('roomId' in request)) throw new Error('Invalid isolated task action.');
      const room = options.room(realpathSync(workspaceRoot), request.roomId);
      if (request.action === 'isolated-setup') {
        options.assertMember(room, room.defaultAgentId);
        if ([...active.keys()].some(id => options.store().all().messages.find(m => m.id === id)?.roomId === room.id)) throw new Error('Wait for isolated tasks to stop before setting up Docker.');
        await platform.setup(room); return;
      }
      if (request.action === 'isolated-submit') {
        const member = room.members.find(m => m.id === request.agentId);
        if (!member) throw new Error('Choose a participant in this room.');
        options.assertMember(room, member.id);
        const previous = options.store().all().messages.find(m => m.id === request.id);
        if (previous) {
          if (previous.roomId !== room.id || previous.recipient !== member.id || previous.text !== request.prompt
            || previous.isolated?.accountId !== member.accountId || previous.isolated.check !== request.check
            || JSON.stringify(previous.isolated.scope) !== JSON.stringify(request.scope)) throw new Error('This message ID belongs to another task.');
          return;
        }
        const taskId = `isolated_${createHash('sha256').update(`${room.id}/${request.id}`).digest('hex')}`;
        const saved: IsolatedWork = { scope: request.scope, check: request.check, accountId: member.accountId, taskId,
          phase: 'preparing', baseRef: null, candidateId: null, workspace: null, branch: null, commit: null, sessionId: null, output: '', diff: '', error: null };
        options.store().update(state => state.messages.push({ id: request.id, roomId: room.id, sender: 'user', recipient: member.id,
          threadId: null, kind: 'message', text: request.prompt, taskId, status: 'running', createdAt: new Date().toISOString(), isolated: saved }));
        const controller = new AbortController();
        const flight = Promise.resolve().then(() => {
          options.assertMember(room, member.id);
          return platform.run(context(room, member.id, member.accountId, request.prompt), saved, patch => update(request.id, patch), controller.signal);
        }).catch(error => {
          update(request.id, { phase: controller.signal.aborted ? 'unknown' : 'failed', error: safeError(error) });
        }).finally(() => { active.delete(request.id); });
        active.set(request.id, { controller, flight });
        // A persistence failure retains the last durable state. Restart inspection never replays it.
        void flight.catch(() => {});
        return;
      }
      if (request.action !== 'isolated-inspect' && request.action !== 'isolated-cancel') throw new Error('Invalid isolated task action.');
      const message = options.store().all().messages.find(m => m.id === request.messageId && m.roomId === room.id);
      if (!message?.isolated || !message.recipient) throw new Error('Unknown isolated task in this room.');
      const pending = active.get(message.id);
      if (request.action === 'isolated-cancel') {
        if (!pending) throw new Error('No live execution is attached. Inspect its recorded outcome.');
        pending.controller.abort(); await pending.flight; return;
      }
      if (pending) throw new Error('This task is still running. Wait for its result or stop it first.');
      try { update(message.id, await platform.inspect(context(room, message.recipient, message.isolated.accountId, message.text), message.isolated)); }
      catch (error) { update(message.id, { phase: message.isolated.phase === 'passed' ? 'stale' : 'unknown', error: safeError(error) }); }
    },
    async settled() { await Promise.all([...active.values()].map(p => p.flight)); },
    async dispose() {
      for (const pending of active.values()) pending.controller.abort();
      await Promise.allSettled([...active.values()].map(p => p.flight));
    },
  };
}
