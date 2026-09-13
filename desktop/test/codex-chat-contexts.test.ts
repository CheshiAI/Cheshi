import { describe, expect, test } from 'bun:test';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { codexThread, createFakeCodexClient, expectFailure } from './codex-chat-test-helpers.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing test item ${index}.`);
  return item;
}

function setup() {
  const clients: Array<ReturnType<typeof createFakeCodexClient> & { stopped: boolean; stop(): Promise<void> }> = [];
  const events: Array<{ ownerId: number; event: Record<string, unknown> }> = [];
  const turnGates = [createDeferred<unknown>(), createDeferred<unknown>()] as const;
  const turnStarted = [createDeferred<void>(), createDeferred<void>()] as const;
  const contexts = new CodexChatContexts({
    service: { cwd: '/workspace/cheshi', serviceName: 'cheshi', developerInstructions: 'Test workspace.' },
    createClient() {
      const index = clients.length;
      const client = {
        ...createFakeCodexClient({
          'model/list': { data: ['one', 'two'].map((model) => ({
            id: model, model, displayName: model, isDefault: model === 'one',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: ['medium', 'high'].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
            serviceTiers: [],
          })) },
          'permissionProfile/list': { data: [
            { id: ':read-only', allowed: true }, { id: ':workspace', allowed: true },
          ] },
          'thread/start': { thread: codexThread(`thread-${index}`) },
          'thread/read': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
          'thread/unsubscribe': {},
          'turn/start': () => {
            turnStarted[index]?.resolve();
            return turnGates[index]?.promise ?? { turn: { id: `turn-${index}` } };
          },
          'turn/interrupt': {},
        }),
        stopped: false,
        async stop() { this.stopped = true; },
      };
      clients.push(client);
      return client;
    },
    emit: (ownerId, event) => events.push({ ownerId, event }),
  });
  return { clients, contexts, events, turnGates, turnStarted };
}

describe('chat pane contexts', () => {
  test('isolates overlapping sends, configuration, cancellation and session selection', async () => {
    const { contexts, clients, events, turnGates, turnStarted } = setup();
    try {
      const left = contexts.get(1, 'left');
      const right = contexts.get(1, 'right');
      await Promise.all([
        left.configure({ model: 'one', effort: 'high' }),
        right.configure({ model: 'two', effort: 'medium' }),
      ]);
      const leftSend = left.sendMessage('Left message', 'left-message');
      const rightSend = right.sendMessage('Right message', 'right-message');
      await Promise.all(turnStarted.map(({ promise }) => promise));
      expect(itemAt(clients, 0).requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
        threadId: 'thread-0', model: 'one', effort: 'high',
      });
      expect(itemAt(clients, 1).requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
        threadId: 'thread-1', model: 'two', effort: 'medium',
      });
      turnGates[0].resolve({ turn: { id: 'turn-0' } });
      turnGates[1].resolve({ turn: { id: 'turn-1' } });
      await Promise.all([leftSend, rightSend]);
      await left.cancelResponse();
      expect(itemAt(clients, 0).requests.filter(({ method }) => method === 'turn/interrupt')).toEqual([
        { method: 'turn/interrupt', params: { threadId: 'thread-0', turnId: 'turn-0' } },
      ]);
      expect(itemAt(clients, 1).requests.some(({ method }) => method === 'turn/interrupt')).toBe(false);
      await left.openSession('different-thread');
      expect(right.getStatus()).toMatchObject({ threadId: 'thread-1', responseInProgress: true, model: 'two' });
      itemAt(clients, 1).emit('item/agentMessage/delta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'Right answer',
      });
      const deltas = events.filter(({ event }) => event.type === 'assistant-delta');
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ ownerId: 1, event: { contextId: 'right', text: 'Right answer' } });
      expect(events.some(({ event }) => event.contextId === 'right' && event.type === 'session-selected' && event.threadId === 'thread-0')).toBe(false);
    } finally { await contexts.stop(); }
  });

  test('keeps permission choices and equal approval ids scoped to their panes', async () => {
    const { contexts, clients, events, turnGates } = setup();
    try {
      const left = contexts.get(1, 'left');
      const right = contexts.get(1, 'right');
      await left.setPermissionMode('ask-for-approval');
      expect(right.currentPermissionMode().id).toBe('read-only');
      turnGates[0].resolve({ turn: { id: 'turn-0' } });
      turnGates[1].resolve({ turn: { id: 'turn-1' } });
      await Promise.all([left.sendMessage('Left', 'left-message'), right.sendMessage('Right', 'right-message')]);
      itemAt(clients, 0).emitRequest(44, 'item/commandExecution/requestApproval', { command: 'left command' });
      itemAt(clients, 1).emitRequest(44, 'item/commandExecution/requestApproval', { command: 'right command' });
      const approvals = events.filter(({ event }) => event.type === 'approval-requested');
      expect(approvals.map(({ event }) => event.contextId)).toEqual(['left', 'right']);
      await left.respondToApproval('approval-1', 'accept');
      expect(itemAt(clients, 0).responsesSent).toEqual([{ id: 44, result: { decision: 'accept' } }]);
      expect(itemAt(clients, 1).responsesSent).toHaveLength(0);
      await right.respondToApproval('approval-1', 'decline');
      expect(itemAt(clients, 1).responsesSent).toEqual([{ id: 44, result: { decision: 'decline' } }]);
    } finally { await contexts.stop(); }
  });

  test('shares catalog refresh without forwarding another pane session selection and isolates owners', async () => {
    const { contexts, events } = setup();
    try {
      const left = contexts.get(1, 'left');
      contexts.get(1, 'right');
      contexts.get(2, 'left');
      left.emit({ type: 'session-created', session: { id: 'new-thread' } });
      expect(events).toEqual([
        { ownerId: 1, event: { type: 'session-created', session: { id: 'new-thread' }, contextId: 'left' } },
        { ownerId: 1, event: { type: 'sessions-changed', contextId: 'right' } },
      ]);
      expect(contexts.get(1, 'left')).toBe(left);
      expect(contexts.get(2, 'left')).not.toBe(left);
    } finally { await contexts.stop(); }
  });

  test('closing one pane stops only its client and drops late events', async () => {
    const { contexts, clients, events } = setup();
    const left = contexts.get(1, 'left');
    const right = contexts.get(1, 'right');
    await contexts.dispose(1, 'left');
    expect(itemAt(clients, 0).stopped).toBe(true);
    expect(itemAt(clients, 1).stopped).toBe(false);
    left.emit({ type: 'session-selected', threadId: 'late' });
    expect(events).toHaveLength(0);
    await expectFailure(() => left.sendMessage('Late send', 'late'), 'This chat pane has been closed.');
    expect(clients[0]?.requests).toHaveLength(0);
    expect(() => contexts.get(1, 'left')).toThrow('This chat pane has been closed.');
    expect(contexts.get(1, 'right')).toBe(right);
    await contexts.disposeOwner(1);
    expect(itemAt(clients, 1).stopped).toBe(true);
    await contexts.stop();
  });

  test('detaches an old renderer synchronously while its clients finish stopping', async () => {
    const { contexts, clients, events } = setup();
    const oldPane = contexts.get(1, 'pane');
    const stopGate = createDeferred<void>();
    itemAt(clients, 0).stop = async () => { await stopGate.promise; };
    const oldCleanup = contexts.disposeOwner(1);
    const newPane = contexts.get(1, 'pane');
    expect(newPane).not.toBe(oldPane);
    contexts.get(1, 'closed-new-pane');
    await contexts.dispose(1, 'closed-new-pane');
    oldPane.emit({ type: 'session-selected', threadId: 'old-page' });
    expect(events).toHaveLength(0);
    stopGate.resolve();
    await oldCleanup;
    expect(contexts.get(1, 'pane')).toBe(newPane);
    expect(itemAt(clients, 1).stopped).toBe(false);
    expect(() => contexts.get(1, 'closed-new-pane')).toThrow('This chat pane has been closed.');
    newPane.emit({ type: 'session-selected', threadId: 'new-page' });
    expect(events).toEqual([{ ownerId: 1, event: { type: 'session-selected', threadId: 'new-page', contextId: 'pane' } }]);
    await contexts.stop();
  });

  test('rejects invalid identifiers before allocating clients', () => {
    const { contexts, clients } = setup();
    for (const id of [null, '', 'bad id', '../pane', 'a'.repeat(129)]) {
      expect(() => contexts.get(1, id)).toThrow('Chat context id');
    }
    expect(clients).toHaveLength(0);
  });
});
