import type { ChatTurnMetricsResponse } from '../shared/chat-turn-metrics.ts';
import type { CodexChatService } from './codex-chat-service.mts';
import { CodexTurnMetricsReader } from './codex-turn-metrics-reader.mts';
import { threadFromReadResponse } from './codex-chat-thread-data.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';
import { requiredString } from './codex-chat-values.mts';

const reader = new CodexTurnMetricsReader();

function assertViewedThread(service: CodexChatService, threadId: string): void {
  if (service.viewedThreadId !== threadId) throw new Error('The conversation changed. Reload response statistics.');
}

export async function readCodexTurnMetrics(service: CodexChatService, requestedId: unknown): Promise<ChatTurnMetricsResponse> {
  const threadId = requiredString(requestedId, 'Conversation id');
  assertViewedThread(service, threadId);
  const raw = service.viewedThreadIsSubagent && service.conversations?.agents
    ? await service.conversations.agents.read(threadId, 'thread/read', { includeTurns: true })
    : service.conversations?.read
      ? await service.conversations.read(threadId, 'thread/read', { includeTurns: true })
      : await service.client.request('thread/read', { threadId, includeTurns: true });
  assertViewedThread(service, threadId);
  const thread = threadFromReadResponse(raw);
  const records = await reader.read(thread);
  assertViewedThread(service, threadId);
  const turns: ChatTurnMetricsResponse['turns'] = [];
  for (const value of Array.isArray(thread.turns) ? thread.turns : []) {
    const turn = recordValue(value);
    const id = stringValue(turn?.id);
    if (!turn || !id || turn.status !== 'completed') continue;
    const itemIds = (Array.isArray(turn.items) ? turn.items : []).flatMap(value => {
      const item = recordValue(value);
      return (item?.type === 'agentMessage' || item?.type === 'plan') && typeof item.id === 'string' ? [item.id] : [];
    });
    if (!itemIds.length) continue;
    const recorded = records.get(id);
    turns.push({
      turnId: id, itemIds, agentName: stringValue(thread.agentNickname) ?? 'Main agent',
      model: recorded?.model ?? null, reasoningEffort: recorded?.reasoningEffort ?? null,
      usage: recorded?.usage ?? null, durationMs: recorded?.durationMs ?? null,
    });
  }
  return { threadId, turns };
}
