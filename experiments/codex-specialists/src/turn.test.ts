import { expect, test } from 'bun:test';
import { deniedServerRequest, type JsonRecord, type Notification } from './protocol.ts';
import { TurnObserver } from './turn.ts';

function completion(status = 'completed', threadId = 'thread', turnId = 'turn'): Notification {
  return { method: 'turn/completed', params: { threadId, turn: {
    id: turnId, status, items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '검증 결과' }],
    error: status === 'failed' ? { message: 'provider failed' } : null,
  } } };
}

test('buffers completion before acknowledgement and filters unrelated turns', async () => {
  const observer = new TurnObserver();
  observer.receive(completion('completed', 'other'));
  observer.receive(completion('completed', 'thread', 'other'));
  observer.receive({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
    item: { id: 'answer', type: 'agentMessage', text: '검증 결과' } } });
  observer.receive(completion());
  observer.identify('thread', 'turn');
  expect(await observer.result).toEqual({ status: 'completed', output: '검증 결과', error: null });
  expect(observer.finished).toBe(true);
});

test('preserves provider failure and excludes commentary from final output', async () => {
  const observer = new TurnObserver();
  observer.identify('thread', 'turn');
  observer.receive({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
    item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'progress' } } });
  observer.receive(completion('failed'));
  expect(await observer.result).toEqual({ status: 'failed', output: '검증 결과', error: 'provider failed' });
});

test('never grants approval, permissions, elicitation, or interactive input', () => {
  const cases: [string, JsonRecord][] = [
    ['item/commandExecution/requestApproval', { decision: 'decline' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['execCommandApproval', { decision: 'denied' }],
    ['applyPatchApproval', { decision: 'denied' }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null }],
    ['item/tool/requestUserInput', { answers: {} }],
  ];
  for (const [method, expected] of cases) expect(deniedServerRequest(method)).toEqual(expected);
  expect(deniedServerRequest('unknown/request')).toBeNull();
});

test('evidence callbacks see only matched native items, including events before turn acknowledgement', async () => {
  const observed: string[] = [];
  const observer = new TurnObserver((method, item) => observed.push(`${method}/${item.id}`));
  const event = (method: string, turnId = 'turn'): Notification => ({ method, params: { threadId: 'thread', turnId,
    item: { id: 'check', type: 'commandExecution', command: 'bun test', exitCode: 0 } } });
  observer.receive(event('item/started', 'foreign'));
  observer.receive(event('item/started')); observer.receive(event('item/completed'));
  observer.identify('thread', 'turn'); observer.receive(completion());
  expect((await observer.result).status).toBe('completed');
  observer.receive(event('item/completed'));
  expect(observed).toEqual(['item/started/check', 'item/completed/check']);
});
