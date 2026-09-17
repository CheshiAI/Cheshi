import type { CodexChatService } from './codex-chat-service.mts';
import { timelineFromThread, threadFromReadResponse } from './codex-chat-thread-data.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';
import { requiredString } from './codex-chat-values.mts';

function assertCurrentThread(service: CodexChatService, threadId: string): void {
  if (service.viewedThreadId !== threadId) throw new Error('The conversation changed. Reopen the agent details.');
}

export async function readCodexAgentDetails(service: CodexChatService, parentId: unknown, requestedIds: unknown) {
  const threadId = requiredString(parentId, 'Conversation id');
  assertCurrentThread(service, threadId);
  if (!Array.isArray(requestedIds) || requestedIds.length === 0 || requestedIds.length > 32
    || requestedIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('Choose between 1 and 32 agent threads.');
  }
  const ids = [...new Set(requestedIds as string[])];
  const { agents } = await service.listAgents();
  assertCurrentThread(service, threadId);
  const allowed = new Map(agents.filter(agent => agent.kind === 'subagent').map(agent => [agent.id, agent]));
  if (ids.some(id => !allowed.has(id))) throw new Error('The agent does not belong to this conversation.');
  const details = await Promise.all(ids.map(async id => {
    const raw = service.conversations?.agents
      ? await service.conversations.agents.read(id, 'thread/read', { includeTurns: true })
      : await service.client.request('thread/read', { threadId: id, includeTurns: true });
    const thread = threadFromReadResponse(raw);
    if (thread.id !== id) throw new Error('The agent response has a different thread identifier.');
    const items = timelineFromThread(thread);
    return {
      id, title: allowed.get(id)!.title,
      status: stringValue(recordValue(thread.status)?.type) ?? stringValue(thread.status) ?? 'unknown',
      model: stringValue(thread.model), reasoningEffort: stringValue(thread.reasoningEffort),
      items: items.slice(-100), omittedItems: Math.max(0, items.length - 100),
      usage: await service.agentTokenUsage.read(thread),
    };
  }));
  assertCurrentThread(service, threadId);
  return { agents: details };
}
