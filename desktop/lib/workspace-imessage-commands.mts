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
      if (command === '상태') return `${waiting ? '사용자 응답 대기 중' : active ? '작업 중' : '대기 중'} · 대기열 ${queued}개`;
      if (command === '중지') {
        // An existing renderer queue must not immediately launch another job after cancellation.
        if (queued) return '대기열이 남아 있습니다. 앱에서 대기열을 비운 뒤 중지해 주세요.';
        const result = await service.cancelResponse(threadId);
        return result.requested ? '현재 작업 중지를 요청했습니다.' : '현재 실행 중인 작업이 없습니다.';
      }
      if (waiting) return '승인 또는 질문이 대기 중입니다. 앱에서 응답한 뒤 지시해 주세요.';
      if (service.pendingTurnStarts.has(threadId)) return '작업을 시작하는 중입니다. 잠시 후 다시 지시해 주세요.';
      if (!active && queued) return '앱의 대기열이 남아 있습니다. 대기열 처리 후 다시 지시해 주세요.';
      service.emit({ type: 'user-message', threadId, clientMessageId: messageId, text: command, createdAt: Date.now() / 1000 });
      if (active) await service.steerMessage(command, messageId, null, [], threadId);
      else {
        const result = await service.sendMessage(command, messageId, null, [], threadId, signal);
        // Account continuity can return a new backing thread for the same conversation.
        // Follow only this send's result while it is still selected, never an unrelated navigation.
        if (result.threadId !== threadId && service.viewedThreadId === result.threadId && options.targetForThread) {
          return { reply: '지시를 접수하고 작업을 시작했습니다.', continuedTarget: options.targetForThread(result.threadId) };
        }
      }
      return active ? '진행 중인 작업에 추가 지시를 전달했습니다.' : '지시를 접수하고 작업을 시작했습니다.';
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
