import path from 'node:path';
import type { CodexChatService } from './codex-chat-service.mts';
import type { IMessageCommandEndpoint, IMessageCommandRegistry } from './imessage-commands.mts';
import type { IMessageCommandTarget } from '../shared/imessage-commands.ts';

export function chatCommandEndpoint(options: {
  id: string; label: string; threadId: string; service: CodexChatService; queueSize(): number;
  targetForThread?(threadId: string): IMessageCommandTarget;
}): IMessageCommandEndpoint {
  const { service, threadId } = options;
  return {
    id: options.id, label: options.label,
    async execute(command, messageId, signal) {
      signal.throwIfAborted();
      if (service.viewedThreadId !== threadId || service.viewedThreadIsSubagent) throw new Error('The selected conversation has changed.');
      const queued = options.queueSize();
      const waiting = [...service.pendingApprovals.values()].some(request => request.threadId === threadId)
        || service.userInputs.list().some(request => request.threadId === threadId);
      const active = service.activeTurns.get(threadId);
      if (command.toLowerCase() === 'status' || command === '상태') return `${waiting ? 'Waiting for your response' : active ? 'Working' : 'Idle'} · Queued messages: ${queued}`;
      if (command.toLowerCase() === 'stop' || command === '중지') {
        // An existing renderer queue must not immediately launch another job after cancellation.
        if (queued) return 'Messages are still queued. Clear the queue in Cheshi before stopping.';
        const result = await service.cancelResponse(threadId);
        return result.requested ? 'Requested a stop for the current task.' : 'No task is currently running.';
      }
      if (waiting) return 'An approval or question is pending. Respond in Cheshi before sending another instruction.';
      if (service.pendingTurnStarts.has(threadId)) return 'A task is starting. Try again shortly.';
      if (!active && queued) return 'Messages are still queued in Cheshi. Send another instruction after the queue finishes.';
      service.emit({ type: 'user-message', threadId, clientMessageId: messageId, text: command, createdAt: Date.now() / 1000 });
      if (active) await service.steerMessage(command, messageId, null, [], threadId);
      else {
        const result = await service.sendMessage(command, messageId, null, [], threadId, signal);
        // Account continuity can return a new backing thread for the same conversation.
        // Follow only this send's result while it is still selected, never an unrelated navigation.
        if (result.threadId !== threadId && service.viewedThreadId === result.threadId && options.targetForThread) {
          return { reply: 'Instruction received. Work has started.', continuedTarget: options.targetForThread(result.threadId) };
        }
      }
      return active ? 'Sent the additional instruction to the current task.' : 'Instruction received. Work has started.';
    },
  };
}

export function registerWorkspaceMessageCommands(options: {
  registry?: IMessageCommandRegistry; workspaceRoot: string;
  services(): Array<{ contextId: string; service: CodexChatService }>;
  queueSize(contextId: string, threadId: string): number;
}) {
  const key = options.workspaceRoot;
  return options.registry?.register(key, () => options.services().flatMap(({ contextId, service }) => {
    const threadId = service.viewedThreadId;
    if (!threadId || service.viewedThreadIsSubagent) return [];
    const targetForThread = (id: string) => ({ id: JSON.stringify([key, contextId, id]),
      label: `${path.basename(key)} · Chat ${id.slice(0, 12)}` });
    return [chatCommandEndpoint({ ...targetForThread(threadId), threadId, service, targetForThread,
      queueSize: () => options.queueSize(contextId, threadId) })];
  })) ?? (() => {});
}
