import type { IpcMainInvokeEvent } from 'electron';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatRelays } from '../lib/codex-chat-relay.mts';
import { expect, test } from 'bun:test';
import { timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
async function failure(operation: Promise<unknown>) {
  try { await operation; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected an error.');
}
function fixture(responses: Record<string, unknown> = {}) {
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('thread') },
    'turn/start': { turn: { id: 'turn' } }, 'turn/steer': { turnId: 'turn' }, ...responses });
  const service = createCodexChatService(client);
  const events: Record<string, unknown>[] = [];
  service.onEvent(event => events.push(event));
  return { client, service, events };
}
const model = { id: 'model', model: 'model', displayName: 'Test model', description: '', isDefault: true,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium', description: '' }], serviceTiers: [], defaultServiceTier: null };

test('steers the expected active turn with text, files and images without starting a new turn', async () => {
  const { service, client } = fixture();
  try {
    await service.sendMessage('Start', 'first');
    const active = service.activeTurns.get('thread');
    expect(await service.steerMessage('Use the smaller change', 'followup', null, [
      { kind: 'image', name: 'view.png', path: '/tmp/view.png' }, { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' },
    ])).toEqual({ threadId: 'thread', turnId: 'turn' });
    expect(client.requests.at(-1)).toMatchObject({ method: 'turn/steer', params: { threadId: 'thread', expectedTurnId: 'turn', clientUserMessageId: 'followup',
      input: [{ type: 'text', text: expect.stringContaining('Use the smaller change') }, { type: 'localImage', path: '/tmp/view.png' }] } });
    expect(service.activeTurns.get('thread')).toBe(active);
    expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  } finally { service.stop(); }
});
test('rejects idle, unacknowledged, interrupted and duplicate steer requests', async () => {
  const gate = createDeferred<unknown>();
  const { service } = fixture({ 'turn/steer': () => gate.promise });
  try {
    expect((await failure(service.steerMessage('Extra', 'idle'))).name).toBe('CodexMessageNotSent');
    await service.sendMessage('Start', 'first');
    const active = service.activeTurns.get('thread')!;
    active.turnId = null;
    expect((await failure(service.steerMessage('Extra', 'starting'))).name).toBe('CodexMessageNotSent');
    active.turnId = 'turn'; active.interruptRequested = true;
    expect((await failure(service.steerMessage('Extra', 'stopping'))).name).toBe('CodexMessageNotSent');
    active.interruptRequested = false;
    const first = service.steerMessage('Extra', 'accepted');
    expect((await failure(service.steerMessage('Extra', 'duplicate'))).name).toBe('CodexMessageNotSent');
    gate.resolve({ turnId: 'turn' });
    await first;
  } finally { service.stop(); }
});
test('failed steering leaves the original response running and classifies uncertain delivery', async () => {
  for (const rejected of [Object.assign(new Error('Turn changed'), { name: 'CodexRequestRejectedError' }), new Error('Timeout')]) {
    const { service, events } = fixture({ 'turn/steer': rejected });
    try {
      await service.sendMessage('Start', 'first');
      const active = service.activeTurns.get('thread');
      const count = events.length;
      const error = await failure(service.steerMessage('Extra', 'followup'));
      expect(error.name).toBe(rejected.name === 'CodexRequestRejectedError' ? 'CodexMessageNotSent' : 'CodexMessageDeliveryUnknown');
      expect(service.activeTurns.get('thread')).toBe(active);
      expect(events).toHaveLength(count);
    } finally { service.stop(); }
  }
});
test('completion racing a steer acknowledgement does not resurrect the old turn', async () => {
  const gate = createDeferred<unknown>();
  const { service, client } = fixture({ 'turn/steer': () => gate.promise });
  try {
    await service.sendMessage('Start', 'first');
    const steering = service.steerMessage('Extra', 'followup');
    client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    client.emit('turn/started', { threadId: 'thread', turn: { id: 'next-turn' } });
    const next = service.activeTurns.get('thread');
    gate.resolve({ turnId: 'turn' });
    expect(await steering).toEqual({ threadId: 'thread', turnId: 'turn' });
    expect(service.activeTurns.get('thread')).toBe(next);
    expect(next?.turnId).toBe('next-turn');
  } finally { service.stop(); }
});
test('a mismatching steer acknowledgement is uncertain and preserves the active turn', async () => {
  const { service } = fixture({ 'turn/steer': { turnId: 'other-turn' } });
  try {
    await service.sendMessage('Start', 'first');
    expect((await failure(service.steerMessage('Extra', 'followup'))).name).toBe('CodexMessageDeliveryUnknown');
    expect(service.activeTurns.get('thread')?.turnId).toBe('turn');
  } finally { service.stop(); }
});
test('Plan uses built-in instructions and remains Plan until an explicit idle switch', async () => {
  const { service, client } = fixture();
  service.availableModels.set(model.model, model);
  try {
    expect(service.setCollaborationMode('plan')).toMatchObject({ collaborationMode: 'plan' });
    expect(client.requests).toHaveLength(0);
    await service.sendMessage('Create a plan', 'first');
    expect(client.requests.at(-1)?.params).toMatchObject({ collaborationMode: { mode: 'plan', settings: { model: 'model', reasoning_effort: 'medium', developer_instructions: null } } });
    expect(() => service.setCollaborationMode('default')).toThrow('Wait for the current response');
    client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    expect(service.configuration()).toMatchObject({ collaborationMode: 'plan' });
    const count = client.requests.length;
    expect(service.setCollaborationMode('default')).toMatchObject({ collaborationMode: 'default' });
    expect(client.requests).toHaveLength(count);
    await service.sendMessage('Implement the approved plan', 'second');
    expect(client.requests.at(-1)?.params).toMatchObject({ collaborationMode: { mode: 'default', settings: { model: 'model', developer_instructions: null } } });
    expect(() => service.setCollaborationMode('invalid')).toThrow();
  } finally { service.stop(); }
});
test('loads an advertised default model before applying Plan and preserves abort errors', async () => {
  const { service, client } = fixture({ 'model/list': { data: [model] } });
  try {
    service.setCollaborationMode('plan');
    await service.sendMessage('Plan', 'first');
    expect(client.requests[0]?.method).toBe('model/list');
    expect(client.requests.at(-1)?.params).toMatchObject({ collaborationMode: { settings: { model: 'model' } } });
    const abort = new AbortController(); abort.abort();
    expect((await failure(service.sendMessage('Aborted', 'cancelled', null, [], undefined, abort.signal))).name).toBe('CodexMessageNotSent');
  } finally { service.stop(); }
});
test('streams Plan separately and uses completed Plan text as authoritative content', async () => {
  const { service, client, events } = fixture();
  try {
    await service.sendMessage('Plan', 'first');
    const identity = { threadId: 'thread', turnId: 'turn', itemId: 'plan-item' };
    client.emit('item/plan/delta', { ...identity, delta: 'Draft plan' });
    client.emit('item/completed', { ...identity, item: { id: 'plan-item', type: 'plan', text: 'Revised final plan' } });
    expect(events.filter(event => String(event.type).startsWith('plan-'))).toEqual([
      { type: 'plan-delta', ...identity, text: 'Draft plan' }, { type: 'plan-completed', ...identity, text: 'Revised final plan' },
    ]);
    expect(timelineFromThread({ thread: { turns: [{ id: 'turn', startedAt: 1, completedAt: 2, items: [{ id: 'plan-item', type: 'plan', text: 'Revised final plan' }] }] } })).toEqual([
      { id: 'plan-item', kind: 'plan', text: 'Revised final plan', createdAt: 2 },
    ]);
    expect(service.activeTurns.size).toBe(1);
  } finally { service.stop(); }
});

test('IPC forwards mode and steering to the correct pane and retains structured failure responses', async () => {
  const { service, client } = fixture();
  const contexts = new CodexChatContexts({ service: { cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test.' },
    createClient: () => ({ ...client, async stop() {} }), emit() {} });
  const relays = new CodexChatRelays({ contexts, emit() {} });
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
  registerCodexChatIpc({ ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    service(_event, contextId) { expect(contextId).toBe('pane'); return service; }, relays,
    savedTurns: { async list() { return []; }, async save() { throw new Error('Unused'); }, async delete() { throw new Error('Unused'); } },
    assertSender(candidate) { expect(candidate).toBe(event); },
    async prepareMessage(value) { if (value === 'invalid') throw new TypeError('Invalid attachment'); return { text: String(value), clientMessageId: 'ipc-message', skill: null, attachments: [], threadId: 'thread' }; },
  });
  try {
    const mode = handlers.get('cheshi:set-codex-collaboration-mode')!;
    const steer = handlers.get('cheshi:steer-codex-chat-message')!;
    expect(await mode(event, 'default', 'pane')).toMatchObject({ collaborationMode: 'default' });
    expect(await steer(event, 'invalid', 'pane')).toEqual({ sendFailure: 'failed', message: 'Invalid attachment' });
    expect(await steer(event, 'Extra', 'pane')).toMatchObject({ sendFailure: 'failed' });
    service.availableModels.set(model.model, model);
    await service.sendMessage('Start', 'first');
    expect(await steer(event, 'Extra', 'pane')).toEqual({ threadId: 'thread', turnId: 'turn' });
    expect(client.requests.at(-1)?.params).toMatchObject({ clientUserMessageId: 'ipc-message', expectedTurnId: 'turn' });
  } finally { service.stop(); await contexts.stop(); }
});


test('the first send after opening a native Plan thread explicitly applies UI Default mode', async () => {
  const { service, client } = fixture({
    'thread/read': { thread: codexThread('saved', { collaborationMode: { mode: 'plan' } }) },
    'thread/resume': { thread: codexThread('saved', { collaborationMode: { mode: 'plan' } }) },
  });
  try {
    await service.openSession('saved');
    expect(service.configuration()).toMatchObject({ collaborationMode: 'default' });
    await service.sendMessage('Implement the change', 'first');
    expect(client.requests.at(-1)).toMatchObject({ method: 'turn/start', params: {
      threadId: 'saved', collaborationMode: { mode: 'default', settings: { model: 'test-model', developer_instructions: null } },
    } });
  } finally { service.stop(); }
});

test('missing advertised models fail before starting or resuming a thread in either mode', async () => {
  for (const mode of ['default', 'plan'] as const) {
    const { service, client } = fixture({ 'model/list': { data: [] } });
    try {
      if (mode === 'plan') service.setCollaborationMode(mode);
      service.selectedModel = 'unadvertised-model';
      expect((await failure(service.sendMessage('Start', 'first'))).name).toBe('CodexMessageNotSent');
      expect(client.requests.map(request => request.method)).toEqual(['model/list']);
      expect(service.activeTurns.size).toBe(0);
      expect(service.pendingTurnStarts.size).toBe(0);
    } finally { service.stop(); }
  }
});

test('model preparation locks mode selection and concurrent sends to the same saved thread', async () => {
  const gate = createDeferred<unknown>();
  const { service, client } = fixture({ 'model/list': () => gate.promise,
    'thread/read': { thread: codexThread('saved') }, 'thread/resume': { thread: codexThread('saved') } });
  try {
    await service.openSession('saved');
    const first = service.sendMessage('Start', 'first');
    expect(() => service.setCollaborationMode('plan')).toThrow('Wait for the current response');
    expect((await failure(service.sendMessage('Duplicate', 'second'))).name).toBe('CodexMessageNotSent');
    gate.resolve({ data: [model] });
    await first;
    expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(client.requests.at(-1)?.params).toMatchObject({ collaborationMode: { mode: 'default' } });
  } finally { service.stop(); }
});
