import { expect, test } from 'bun:test';
import { CodexChatUserInputs } from '../lib/codex-chat-user-input.mts';
import { chatUserInputRequest, chatUserInputResponse } from '../shared/chat-user-input.ts';
import { userInputRequest } from '../lib/codex-chat-user-input-schema.mts';
import { createFakeCodexClient, createCodexChatService, codexThread, expectFailure } from './codex-chat-test-helpers.ts';

const questions = { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true,
  questions: [{ id: 'choice', header: 'Choice', question: 'Choose one', options: [{ label: 'A', description: 'First' }], isOther: true, isSecret: false }] };
function fixture() {
  const client = createFakeCodexClient(); const events: Record<string, unknown>[] = [];
  const manager = new CodexChatUserInputs(client, event => events.push(event));
  return { client, events, manager };
}
test('normalizes questions, accepts typed answers and rejects stale and unknown answers', async () => {
  const { manager, client, events } = fixture();
  manager.handle({ id: 1, method: 'item/tool/requestUserInput', params: questions });
  const request = manager.list()[0]!;
  expect(chatUserInputRequest(request)).toEqual(request);
  expect(events[0]).toEqual({ type: 'user-input-requested', request });
  await expectFailure(() => manager.respond(request.id, { action: 'accept', answers: { extra: ['x'] } }), 'An answer refers to an unknown question.');
  await manager.respond(request.id, { action: 'accept', answers: { choice: ['Custom answer'] } });
  expect(client.responsesSent).toEqual([{ id: 1, result: { answers: { choice: { answers: ['Custom answer'] } } } }]);
  expect(events.at(-1)).toEqual({ type: 'user-input-resolved', requestId: request.id, threadId: 'thread' });
  await expectFailure(() => manager.respond(request.id, { action: 'cancel' }), 'The input request is no longer available.');
});
test('validates form types, bounds and options without coercing false or zero', async () => {
  const { manager, client } = fixture();
  manager.handle({ id: 2, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: null, serverName: 'server', mode: 'form', message: 'Configure',
    requestedSchema: { type: 'object', required: ['enabled', 'count', 'tags'], properties: {
      enabled: { type: 'boolean' }, count: { type: 'integer', minimum: 0, maximum: 4 },
      tags: { type: 'array', items: { anyOf: [{ const: 'one', title: 'One' }, { const: 'two', title: 'Two' }] }, minItems: 1 },
    } } } });
  const request = manager.list()[0]!;
  expect(chatUserInputRequest(request)).toEqual(request);
  await expectFailure(() => manager.respond(request.id, { action: 'accept', content: { enabled: false, count: 7, tags: ['one'] } }), 'count is out of range.');
  await expectFailure(() => manager.respond(request.id, { action: 'accept', content: { enabled: false, count: 0, tags: ['other'] } }), 'tags contains an invalid choice.');
  await manager.respond(request.id, { action: 'accept', content: { enabled: false, count: 0, tags: ['one', 'two'] } });
  expect(client.responsesSent[0]).toEqual({ id: 2, result: { action: 'accept', content: { enabled: false, count: 0, tags: ['one', 'two'] } } });
});
test('URL requests are data only and allow accept, decline and cancel without opening a browser', async () => {
  for (const action of ['accept', 'decline', 'cancel'] as const) {
    const { manager, client } = fixture();
    manager.handle({ id: 'url', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', serverName: 'server', mode: 'url', message: 'Sign in', url: 'https://example.test/signin', elicitationId: 'login' } });
    expect(manager.list()[0]?.kind).toBe('url');
    await manager.respond(manager.list()[0]!.id, { action });
    expect(client.responsesSent).toEqual([{ id: 'url', result: { action } }]);
  }
});
test('unsupported rich forms remain visible and can be declined, invalid URLs cancel safely', async () => {
  const { manager, client } = fixture();
  manager.handle({ id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', serverName: 'server', mode: 'openai/form', message: 'Nested', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } } });
  const request = manager.list()[0]!;
  expect(request.kind).toBe('form');
  expect('unsupportedReason' in request && typeof request.unsupportedReason).toBe('string');
  await expectFailure(() => manager.respond(request.id, { action: 'accept' }), 'This form contains unsupported nested or complex fields.');
  await manager.respond(request.id, { action: 'decline' });
  manager.handle({ id: 2, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', mode: 'url', url: 'javascript:alert(1)' } });
  await Promise.resolve();
  expect(client.responsesSent).toEqual([{ id: 1, result: { action: 'decline' } }, { id: 2, result: { action: 'cancel' } }]);
});
test('cancellation and server resolution clear only the matching thread and make late answers stale', async () => {
  const { manager, client } = fixture();
  manager.handle({ id: 1, method: 'item/tool/requestUserInput', params: questions });
  manager.handle({ id: 2, method: 'item/tool/requestUserInput', params: { ...questions, threadId: 'other' } });
  const first = manager.list()[0]!;
  await manager.cancel('thread');
  expect(client.responsesSent).toEqual([{ id: 1, result: { answers: {} } }]);
  expect(manager.list().map(request => request.threadId)).toEqual(['other']);
  manager.serverResolved({ requestId: 2, threadId: 'wrong' });
  expect(manager.list()).toHaveLength(1);
  manager.serverResolved({ requestId: 2, threadId: 'other' });
  expect(manager.list()).toHaveLength(0);
  await expectFailure(() => manager.respond(first.id, { action: 'accept', answers: { choice: ['A'] } }), 'The input request is no longer available.');
});
test('pending input survives a failed response and concurrent responses are rejected', async () => {
  const { manager, client } = fixture();
  manager.handle({ id: 1, method: 'item/tool/requestUserInput', params: questions });
  const request = manager.list()[0]!;
  const original = client.respond;
  client.respond = async () => { throw new Error('write failed'); };
  await expectFailure(() => manager.respond(request.id, { action: 'cancel' }), 'write failed');
  expect(manager.list()).toHaveLength(1);
  client.respond = original;
  const response = manager.respond(request.id, { action: 'cancel' });
  await expectFailure(() => manager.respond(request.id, { action: 'cancel' }), 'The input request is no longer available.');
  await response;
});
test('transport failure clears subscriptions and inputs, then resumes before sending again', async () => {
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('thread') }, 'thread/resume': { thread: codexThread('thread') }, 'turn/start': { turn: { id: 'turn' } } });
  const service = createCodexChatService(client);
  const events: Record<string, unknown>[] = []; service.onEvent(event => events.push(event));
  await service.sendMessage('first', 'first');
  client.emitRequest(1, 'item/tool/requestUserInput', questions);
  expect(service.userInputs.list()).toHaveLength(1);
  service.handleFailure(new Error('server exited'));
  expect(service.userInputs.list()).toHaveLength(0);
  expect(service.subscribedThreadIds.size).toBe(0);
  const start = client.requests.length;
  await service.sendMessage('retry', 'retry');
  expect(client.requests.slice(start).map(request => request.method)).toEqual(['thread/resume', 'mcpServerStatus/list', 'turn/start']);
  expect(events.some(event => event.type === 'user-input-resolved')).toBe(true);
  service.stop();
});
test('turn completion, stop and server resolution dismiss inputs without sending stale responses', async () => {
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('thread') }, 'turn/start': { turn: { id: 'turn' } } });
  const service = createCodexChatService(client);
  await service.sendMessage('first', 'first');
  client.emitRequest(1, 'item/tool/requestUserInput', questions);
  client.emit('serverRequest/resolved', { requestId: 1, threadId: 'thread' });
  expect(service.userInputs.list()).toHaveLength(0);
  client.emitRequest(2, 'item/tool/requestUserInput', questions);
  client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  expect(service.userInputs.list()).toHaveLength(0);
  client.emitRequest(3, 'item/tool/requestUserInput', questions);
  service.stop();
  expect(service.userInputs.list()).toHaveLength(0);
  expect(client.responsesSent).toHaveLength(0);
});
test('validates IPC response boundary and secret flag literally', () => {
  expect(() => chatUserInputResponse({ action: 'accept', content: { value: NaN } })).toThrow();
  expect(() => chatUserInputResponse({ action: 'accept', answers: { choice: [1] } })).toThrow();
  expect(chatUserInputRequest({ kind: 'url', id: 'x', threadId: 't', turnId: null, serverName: 'm', message: 'x', url: 'file:///tmp/x', elicitationId: 'x' })).toBeNull();
  expect(userInputRequest('id', 'item/tool/requestUserInput', { ...questions, questions: [{ ...questions.questions[0], isSecret: 'true' }] })).toMatchObject({ questions: [{ isSecret: false }] });
});

test('complex schema constraints and unknown modes cannot be silently accepted', async () => {
  const variants = [
    { mode: 'unknown', requestedSchema: { type: 'object', properties: {} } },
    { mode: 'openai/form', requestedSchema: { type: 'object', properties: {}, anyOf: [] } },
    { mode: 'openai/form', requestedSchema: { type: 'object', properties: { code: { type: 'string', pattern: '^x' } } } },
    { mode: 'openai/form', requestedSchema: { type: 'object', properties: { count: { type: 'number', multipleOf: 3 } } } },
    { mode: 'openai/form', requestedSchema: { type: 'object', required: ['missing'], properties: {} } },
  ];
  for (const variant of variants) {
    const { manager, client } = fixture();
    manager.handle({ id: 'request', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', serverName: 'server', message: 'Form', ...variant } });
    const request = manager.list()[0]!;
    expect(request.kind).toBe('form');
    const reason = 'unsupportedReason' in request ? request.unsupportedReason : undefined;
    expect(typeof reason).toBe('string');
    await expectFailure(() => manager.respond(request.id, { action: 'accept', content: {} }), reason!);
    await manager.respond(request.id, { action: 'cancel' });
    expect(client.responsesSent).toEqual([{ id: 'request', result: { action: 'cancel' } }]);
  }
});
test('turn-scoped cleanup also clears uncorrelated MCP requests in that thread', () => {
  const { manager } = fixture();
  const elicitation = { threadId: 'thread', turnId: null, serverName: 'server', mode: 'form', message: 'Configure', requestedSchema: { type: 'object', properties: {} } };
  manager.handle({ id: 1, method: 'mcpServer/elicitation/request', params: elicitation });
  manager.handle({ id: 2, method: 'mcpServer/elicitation/request', params: { ...elicitation, threadId: 'other' } });
  manager.handle({ id: 3, method: 'item/tool/requestUserInput', params: { ...questions, turnId: 'next-turn' } });
  manager.clear('thread', 'turn');
  expect(manager.list().map(request => request.threadId)).toEqual(['other', 'thread']);
  expect(manager.list().map(request => request.turnId)).toEqual([null, 'next-turn']);
});
