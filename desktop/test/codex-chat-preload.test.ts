import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop.ts';

function createHarness(userName: unknown = 'Alex', invokeResult: unknown = undefined) {
  let api: Record<string, (...args: unknown[]) => unknown> = {};
  const calls: unknown[][] = [];
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform },
    window: { addEventListener() {} },
    document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_key: string, value: typeof api) { api = value; } },
        ipcRenderer: {
          sendSync() { return { workspaceName: 'test', workspaceRoot: '/tmp/test', userName }; },
          async invoke(...args: unknown[]) { calls.push(structuredClone(args)); return invokeResult; },
          on(channel: string, listener: (event: unknown, value: unknown) => void) {
            let entries = listeners.get(channel);
            if (!entries) { entries = new Set(); listeners.set(channel, entries); }
            entries.add(listener);
          },
          removeListener(channel: string, listener: (event: unknown, value: unknown) => void) { listeners.get(channel)?.delete(listener); },
        },
      };
    },
  });
  return {
    calls,
    read(name: string): unknown { return api[name]; },
    call(name: string, ...args: unknown[]) {
      const operation = api[name];
      assert.ok(operation);
      return operation(...args);
    },
    emit(value: unknown, channel = 'cheshi:codex-chat-event') { for (const listener of listeners.get(channel) ?? []) listener({}, value); },
  };
}

test('internal workspace file paths use the existing attachment import IPC', async () => {
  const attachments = [{ kind: 'image', name: '샘플 image.png', path: '/stored/image.png' }];
  const harness = createHarness('Alex', attachments);
  const path = '/tmp/test/resources/샘플 image.png';
  assert.deepEqual(await harness.call('importCodexChatAttachments', [path]), attachments);
  assert.deepEqual(harness.calls, [['cheshi:import-codex-chat-attachments', [{ path }]]]);
});

test('temporary chat uses dedicated IPC channels without a persistent chat context', async () => {
  const harness = createHarness('Alex', { status: 'ok', value: [] });
  const temporary = harness.read('temporaryChat') as CheshiDesktopApi['temporaryChat'];
  assert.ok(temporary);
  const message = { model: 'test', effort: 'low', text: 'Hello', attachments: [] };
  await temporary.models('temporary-id');
  await temporary.selectAttachments('temporary-id');
  await temporary.send('temporary-id', message);
  await temporary.close('temporary-id');
  assert.deepEqual(harness.calls, [
    ['cheshi:temporary-chat-models', 'temporary-id'],
    ['cheshi:temporary-chat-attachments', 'temporary-id'],
    ['cheshi:temporary-chat-send', 'temporary-id', message],
    ['cheshi:temporary-chat-close', 'temporary-id'],
  ]);
});

test('temporary chat cancellation is unwrapped in the renderer instead of rejecting the Electron handler', async () => {
  const harness = createHarness('Alex', { status: 'closed' });
  const temporary = harness.read('temporaryChat') as CheshiDesktopApi['temporaryChat'];
  for (const operation of [
    () => temporary.models('session'),
    () => temporary.send('session', { model: 'test', effort: 'low', text: 'Hi', attachments: [] }),
    () => temporary.selectAttachments('session'),
  ]) {
    await assert.rejects(operation, { name: 'TemporaryChatClosedError', message: 'Temporary chat is closed.' });
  }
});

test('temporary chat unwraps successful replies and rejects malformed replies', async () => {
  const response = { text: 'Reply', model: 'test' };
  const temporary = createHarness('Alex', { status: 'ok', value: response }).read('temporaryChat') as CheshiDesktopApi['temporaryChat'];
  assert.deepEqual(structuredClone(await temporary.send('session', { model: 'test', effort: 'low', text: 'Hi', attachments: [] })), response);
  for (const response of [null, {}, { status: 'ok' }, { status: 'unexpected' }]) {
    const invalid = createHarness('Alex', response).read('temporaryChat') as CheshiDesktopApi['temporaryChat'];
    await assert.rejects(() => invalid.models('session'));
  }
});

test('routes pane operations through the built preload with their context id', async () => {
  const harness = createHarness();
  await harness.call('configureCodexChat', { model: 'model-one' }, 'left');
  await harness.call('sendCodexChatMessage', 'hello', 'message', null, [], null, 'right');
  await harness.call('cancelCodexChatResponse', 'thread', 'left');
  await harness.call('respondCodexChatApproval', 'approval-1', 'decline', 'right');
  await harness.call('disposeCodexChatContext', 'left');
  assert.deepEqual(harness.calls, [
    ['cheshi:configure-codex-chat', { model: 'model-one' }, 'left'],
    ['cheshi:send-codex-chat-message', { text: 'hello', clientMessageId: 'message', skill: null, attachments: [], threadId: null }, 'right'],
    ['cheshi:cancel-codex-chat-response', 'thread', 'left'],
    ['cheshi:respond-codex-chat-approval', 'approval-1', 'decline', 'right'],
    ['cheshi:dispose-codex-chat-context', 'left'],
  ]);
});

test('routes session deletion and rejects missing identifiers before invoking the backend', async () => {
  const harness = createHarness('Alex', { threadIds: ['thread'] });
  assert.deepEqual(structuredClone(await harness.call('deleteCodexChatSession', 'thread', 'left')), { threadIds: ['thread'] });
  assert.deepEqual(harness.calls, [['cheshi:delete-codex-chat-session', 'thread', 'left']]);
  for (const value of [null, undefined, '', '   ', 42]) {
    assert.throws(() => harness.call('deleteCodexChatSession', value), /non-empty string/);
  }
  assert.equal(harness.calls.length, 1);
});

test('validates session history search requests and responses through the built bridge', async () => {
  const response = { hits: [], total: 0, indexedSessions: 2, unavailableSessions: ['unavailable'] };
  const harness = createHarness('Alex', response);
  assert.deepEqual(structuredClone(await harness.call('searchCodexChatHistory', { query: 'error', filePath: 'src/app.ts' }, 'left')), response);
  assert.deepEqual(harness.calls, [['cheshi:search-codex-chat-history', {
    query: 'error', filePath: 'src/app.ts', refresh: false, limit: 50,
  }, 'left']]);
  await assert.rejects(async () => harness.call('searchCodexChatHistory', { query: '', refresh: 'true' }), /Invalid chat history/);
  await assert.rejects(async () => createHarness('Alex', null).call('searchCodexChatHistory', { query: 'error' }), /Invalid chat history/);
  assert.equal(harness.calls.length, 1);
});

test('validates saved record deletion ids and acknowledgements through the built preload', async () => {
  for (const [method, channel, id] of [
    ['deleteCodexSavedTurn', 'cheshi:delete-codex-saved-turn', 'a'.repeat(64)],
    ['deleteCodexChatRelayHistory', 'cheshi:delete-codex-chat-relay-history', 'relay-id'],
  ] as const) {
    const harness = createHarness('Alex', { id });
    assert.deepEqual(structuredClone(await harness.call(method, id)), { id });
    assert.deepEqual(harness.calls, [[channel, id]]);
    for (const invalid of ['', '../escape', 'a/b', null, 42]) {
      await assert.rejects(async () => harness.call(method, invalid), /Invalid saved record id/);
    }
    assert.equal(harness.calls.length, 1);
    for (const response of [null, {}, { id: 'different' }]) {
      await assert.rejects(async () => createHarness('Alex', response).call(method, id), /Invalid saved record deletion response/);
    }
  }
});

test('filters raw selection, configuration and stream events before delivering them to panes', () => {
  const harness = createHarness();
  const left: unknown[] = [];
  const right: unknown[] = [];
  const legacy: unknown[] = [];
  const remove = harness.call('onCodexChatEvent', (value: unknown) => left.push(value), 'left');
  harness.call('onCodexChatEvent', (value: unknown) => right.push(value), 'right');
  harness.call('onCodexChatEvent', (value: unknown) => legacy.push(value));
  const selection = { type: 'session-selected', threadId: 'first', contextId: 'left' };
  const stream = { type: 'assistant-delta', text: 'answer', contextId: 'right' };
  const permission = { type: 'permission-mode-changed', contextId: 'right' };
  const defaultEvent = { type: 'session-selected', threadId: 'legacy' };
  for (const value of [selection, stream, permission, defaultEvent, null]) harness.emit(value);
  assert.deepEqual(left, [selection]);
  assert.deepEqual(right, [stream, permission]);
  assert.deepEqual(legacy, [defaultEvent]);
  assert.equal(typeof remove, 'function');
  if (typeof remove === 'function') remove();
  harness.emit(selection);
  assert.equal(left.length, 1);
});


test('loads chat contexts through the native strip-only TypeScript runtime', async () => {
  const { CodexChatContexts } = await import('../lib/codex-chat-contexts.mts');
  assert.equal(typeof CodexChatContexts, 'function');
  const { CodexChatRelays } = await import('../lib/codex-chat-relay.mts');
  const { registerCodexChatIpc } = await import('../lib/codex-chat-ipc.mts');
  const { CodexChatRelayHistory } = await import('../lib/codex-chat-relay-history.mts');
  assert.equal(typeof CodexChatRelays, 'function');
  assert.equal(typeof registerCodexChatIpc, 'function');
  assert.equal(typeof CodexChatRelayHistory, 'function');
  const { CodexChatSavedTurns } = await import('../lib/codex-chat-saved-turns.mts');
  assert.equal(typeof CodexChatSavedTurns, 'function');
});

test('validates saved turn requests and persisted responses through the built preload', async () => {
  const input = { threadId: 'thread', itemId: 'answer', sessionTitle: 'Title', userText: 'Question', assistantText: '**Answer**', createdAt: 123 };
  const record = { ...input, id: 'a'.repeat(64), savedAt: '2026-09-08T00:00:00.000Z' };
  const save = createHarness('Alex', record);
  assert.deepEqual(structuredClone(await save.call('saveCodexTurn', input)), record);
  assert.deepEqual(save.calls, [['cheshi:save-codex-turn', input]]);
  await assert.rejects(async () => save.call('saveCodexTurn', { ...input, assistantText: '' }), /Invalid saved turn/);
  assert.equal(save.calls.length, 1);
  const list = createHarness('Alex', [record]);
  assert.deepEqual(structuredClone(await list.call('listCodexSavedTurns')), [record]);
  assert.deepEqual(list.calls, [['cheshi:list-codex-saved-turns']]);
  for (const value of [null, {}, [record, { ...record, id: '../escape' }]]) {
    await assert.rejects(async () => createHarness('Alex', value).call('listCodexSavedTurns'), /Invalid saved turn/);
  }
  await assert.rejects(async () => createHarness('Alex', null).call('saveCodexTurn', input), /Invalid saved turn/);
});

test('validates persisted history responses at the preload boundary', async () => {
  const { chatRelayHistoryRecord } = await import('../shared/chat-relay.ts');
  const record = { id: 'relay', objective: 'Compare plans.', startedAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z', finishedAt: '2026-09-08T00:00:00.000Z',
    state: { id: 'relay', sourceContextId: 'a', sourceThreadId: 'thread-a', targetContextId: 'b', targetThreadId: 'thread-b',
      mode: 'debate', maxRounds: 1, status: 'completed', step: 3, round: 1, speaker: 'A', phase: 'review',
      outcome: 'debated', proposalVersion: null, proposal: null, issues: [], summary: 'Remaining differences.', message: null } };
  const harness = createHarness('Alex', [record]);
  assert.deepEqual(structuredClone(await harness.call('listCodexChatRelayHistory')), [chatRelayHistoryRecord(record)]);
  assert.deepEqual(harness.calls, [['cheshi:list-codex-chat-relay-history']]);
  for (const value of [null, {}, [record, { ...record, id: '../escape' }]]) {
    await assert.rejects(async () => createHarness('Alex', value).call('listCodexChatRelayHistory'), /Invalid conversation history/);
  }
});

test('exposes the OS user name through workspace metadata with a safe fallback', () => {
  assert.equal(createHarness('Alex').read('userName'), 'Alex');
  assert.equal(createHarness(null).read('userName'), '');
  assert.equal(createHarness(42).read('userName'), '');
});

test('preserves C selection and synthesis events through the built preload', async () => {
  const harness = createHarness();
  const request = { sourceContextId: 'a', sourceThreadId: 'thread-a', targetContextId: 'b', targetThreadId: 'thread-b',
    moderatorContextId: 'c', moderatorThreadId: 'thread-c', objective: 'Compare fairly.', mode: 'debate', maxRounds: 1 };
  await harness.call('startCodexChatRelay', request);
  assert.deepEqual(harness.calls, [['cheshi:start-codex-chat-relay', request]]);
  assert.throws(() => harness.call('startCodexChatRelay', { ...request, moderatorThreadId: 'thread-a' }), /separate conversation/);
  const received: unknown[] = [];
  harness.call('onCodexChatRelayEvent', (state: unknown) => received.push(state));
  const { objective: _objective, ...identity } = request;
  const state = { ...identity, id: 'relay', status: 'completed', step: 3, round: 1, speaker: 'C', phase: 'synthesis',
    outcome: 'debated', proposalVersion: null, proposal: null, issues: [], summary: 'C’s balanced summary.', message: null };
  harness.emit(state, 'cheshi:codex-chat-relay-event');
  harness.emit({ ...state, speaker: 'A' }, 'cheshi:codex-chat-relay-event');
  assert.deepEqual(structuredClone(received), [state]);
});


test('validates relay requests and isolates validated relay state on its dedicated channel', async () => {
  const harness = createHarness();
  const request = { sourceContextId: 'source', sourceThreadId: 'a', targetContextId: 'target', targetThreadId: 'b', objective: 'Compare approaches.' };
  await harness.call('startCodexChatRelay', request);
  assert.deepEqual(harness.calls, [['cheshi:start-codex-chat-relay', { ...request, mode: 'review', maxRounds: 1 }]]);
  assert.throws(() => harness.call('startCodexChatRelay', { ...request, targetThreadId: 'a' }), /different conversations/);
  assert.throws(() => harness.call('startCodexChatRelay', { ...request, objective: '' }), /objective/);
  const received: unknown[] = [];
  harness.call('onCodexChatRelayEvent', (state: unknown) => received.push(state));
  const valid = { id: 'relay', status: 'running', step: 1, message: null,
    mode: 'review', maxRounds: 1, round: 1, speaker: 'A', phase: 'proposal', outcome: null,
    proposalVersion: null, proposal: null, issues: [], summary: null,
    sourceContextId: 'source', sourceThreadId: 'a', targetContextId: 'target', targetThreadId: 'b' };
  harness.emit(valid);
  harness.emit({ ...valid, status: { toString: null } }, 'cheshi:codex-chat-relay-event');
  harness.emit({ ...valid, step: 4 }, 'cheshi:codex-chat-relay-event');
  harness.emit(valid, 'cheshi:codex-chat-relay-event');
  assert.deepEqual(structuredClone(received), [valid]);
});

test('passes bounded consensus requests and validates extended progress through built preload', async () => {
  const harness = createHarness();
  const request = { sourceContextId: 'source', sourceThreadId: 'a', targetContextId: 'target', targetThreadId: 'b',
    objective: 'Agree on a plan.', mode: 'consensus', maxRounds: 2 };
  await harness.call('startCodexChatRelay', request);
  assert.deepEqual(harness.calls, [['cheshi:start-codex-chat-relay', request]]);
  assert.throws(() => harness.call('startCodexChatRelay', { ...request, maxRounds: 6 }), /rounds/);
  const received: unknown[] = [];
  harness.call('onCodexChatRelayEvent', (state: unknown) => received.push(state));
  const state = { ...request, id: 'relay', status: 'completed', step: 5, round: 2, speaker: 'A', phase: 'confirmation',
    outcome: 'agreed', proposalVersion: 2, proposal: 'The shared plan.', issues: [], summary: 'Both agree.', message: 'Agreed.' };
  harness.emit({ ...state, round: 3 }, 'cheshi:codex-chat-relay-event');
  harness.emit({ ...state, issues: ['Still unresolved.'] }, 'cheshi:codex-chat-relay-event');
  harness.emit(state, 'cheshi:codex-chat-relay-event');
  const { objective: _objective, ...expected } = state;
  assert.deepEqual(structuredClone(received), [expected]);
});

test('validates and routes structured user input at the preload boundary', async () => {
  const request = { id: 'input-one', threadId: 'thread', turnId: 'turn', kind: 'questions', isBlocking: true,
    questions: [{ id: 'question', header: 'Choice', question: 'Choose', isOther: true, isSecret: false, options: null }] };
  const harness = createHarness('Alex', [request]);
  assert.deepEqual(structuredClone(await harness.call('listCodexChatUserInputs', 'left')), [request]);
  await harness.call('respondCodexChatUserInput', 'input-one', { action: 'accept', answers: { question: ['answer'] } }, 'left');
  assert.deepEqual(harness.calls, [
    ['cheshi:list-codex-chat-user-inputs', 'left'],
    ['cheshi:respond-codex-chat-user-input', 'input-one', { action: 'accept', answers: { question: ['answer'] } }, 'left'],
  ]);
  assert.throws(() => harness.call('respondCodexChatUserInput', '', { action: 'cancel' }, 'left'), /request id/);
  assert.throws(() => harness.call('respondCodexChatUserInput', 'input-one', { action: 'invalid' }, 'left'), /action/);
  await assert.rejects(async () => createHarness('Alex', [{}]).call('listCodexChatUserInputs', 'left'), /input request/);
  const { CodexChatUserInputs } = await import('../lib/codex-chat-user-input.mts');
  assert.equal(typeof CodexChatUserInputs, 'function');
});

test('routes additional instructions and validates conversation mode through preload', async () => {
  const harness = createHarness();
  await harness.call('steerCodexChatMessage', 'also test it', 'steer-one', null, [], 'thread', 'pane');
  await harness.call('setCodexChatCollaborationMode', 'plan', 'pane');
  await harness.call('setCodexChatCollaborationMode', 'default', 'pane');
  assert.deepEqual(harness.calls, [
    ['cheshi:steer-codex-chat-message', { text: 'also test it', clientMessageId: 'steer-one', skill: null, attachments: [], threadId: 'thread' }, 'pane'],
    ['cheshi:set-codex-collaboration-mode', 'plan', 'pane'],
    ['cheshi:set-codex-collaboration-mode', 'default', 'pane'],
  ]);
  assert.throws(() => harness.call('setCodexChatCollaborationMode', 'full-access', 'pane'), /Invalid collaboration mode/);
  assert.throws(() => harness.call('steerCodexChatMessage', '', 'steer-two'), /non-empty string/);
  assert.equal(harness.calls.length, 3);
});
