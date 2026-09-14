import { expect, test } from 'bun:test';
import { stopCodexCommands } from '../lib/codex-chat-stop.mts';
import type { ActiveTurn } from '../lib/codex-chat-types.mts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

const listMethod = 'thread/backgroundTerminals/list';
const terminateMethod = 'thread/backgroundTerminals/terminate';
const emptyPage = { data: [], nextCursor: null };

function activeTurn(): ActiveTurn {
  return { threadId: 'thread', turnId: 'turn', clientMessageId: 'message', deltaItemIds: new Set(),
    interruptRequested: true, startedEmitted: true, commands: new Map() };
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected the operation to fail.');
}

test('stops only this turn command items across pages using opaque process ids', async () => {
  const active = activeTurn();
  active.commands.set('foreground', { processId: null, completed: false });
  active.commands.set('background', { processId: 'old-reference', completed: true });
  const terminated: string[] = [];
  const client = createFakeCodexClient({
    [listMethod]: (params: Record<string, unknown>) => {
      if (terminated.length === 2) return emptyPage;
      return params.cursor === 'page-two' ? { data: [
        { itemId: 'background', processId: 'opaque-background' },
      ], nextCursor: null } : { data: [
        { itemId: 'unrelated-turn-command', processId: 'untouched' },
        { itemId: 'foreground', processId: 'opaque-foreground' },
      ], nextCursor: 'page-two' };
    },
    [terminateMethod]: (params: Record<string, unknown>) => {
      terminated.push(String(params.processId));
      return { terminated: true };
    },
  });
  await stopCodexCommands(client, active);
  expect(terminated).toEqual(['opaque-foreground', 'opaque-background']);
  expect(client.requests[1]).toEqual({ method: listMethod, params: { threadId: 'thread', cursor: 'page-two', limit: 100 } });
  expect(client.requests.filter(request => request.method === terminateMethod).map(request => request.params)).toEqual([
    { threadId: 'thread', processId: 'opaque-foreground' }, { threadId: 'thread', processId: 'opaque-background' },
  ]);
});

test('terminates an observed foreground process even before the list contains it', async () => {
  const active = activeTurn();
  active.commands.set('command', { processId: 'opaque-live', completed: false });
  const client = createFakeCodexClient({ [listMethod]: emptyPage, [terminateMethod]: { terminated: true } });
  await stopCodexCommands(client, active);
  expect(client.requests.filter(request => request.method === terminateMethod)).toHaveLength(1);
});

test('does not terminate completed command ids absent from the running list', async () => {
  const active = activeTurn();
  active.commands.set('old-command', { processId: 'stale-reference', completed: true });
  const client = createFakeCodexClient({ [listMethod]: emptyPage });
  await stopCodexCommands(client, active);
  expect(client.requests.every(request => request.method === listMethod)).toBe(true);
  const idle = createFakeCodexClient();
  await stopCodexCommands(idle, activeTurn());
  expect(idle.requests).toHaveLength(0);
});

test('retries a false termination until confirmed without treating false as success', async () => {
  const active = activeTurn();
  active.commands.set('command', { processId: 'opaque-live', completed: false });
  let attempts = 0;
  const client = createFakeCodexClient({ [listMethod]: emptyPage,
    [terminateMethod]: () => ({ terminated: ++attempts === 2 }) });
  await stopCodexCommands(client, active);
  expect(attempts).toBe(2);
});

test('accepts a natural exit during a false termination once the item and list agree', async () => {
  const active = activeTurn();
  const command = { processId: 'opaque-live', completed: false };
  active.commands.set('command', command);
  const client = createFakeCodexClient({ [listMethod]: emptyPage,
    [terminateMethod]: () => { command.completed = true; return { terminated: false }; } });
  await stopCodexCommands(client, active);
  expect(client.requests.filter(request => request.method === terminateMethod)).toHaveLength(1);
});

test('leaves unconfirmed commands retryable after the bounded termination attempts', async () => {
  const active = activeTurn();
  active.commands.set('command', { processId: 'opaque-live', completed: false });
  const client = createFakeCodexClient({ [listMethod]: emptyPage, [terminateMethod]: { terminated: false } });
  expect((await failure(stopCodexCommands(client, active))).message).toContain('Press Stop again');
  expect(client.requests.filter(request => request.method === terminateMethod)).toHaveLength(20);
  expect(active.commands.get('command')?.completed).toBe(false);
});

test('rejects malformed list pages and cursor loops without terminating unrelated processes', async () => {
  const active = activeTurn();
  active.commands.set('command', { processId: null, completed: false });
  for (const page of [null, { data: null, nextCursor: null },
    { data: [{ itemId: 'command', processId: 123 }], nextCursor: null },
    { data: [], nextCursor: 1 }, { data: [], nextCursor: 'repeat' }]) {
    // Keep the malformed response confined to the fake transport boundary.
    const client = createFakeCodexClient({ [listMethod]: () => page });
    expect((await failure(stopCodexCommands(client, active))).message).toMatch(/invalid|repeated/);
    expect(client.requests.some(request => request.method === terminateMethod)).toBe(false);
  }
});

test('reports command list and termination API failures and invalid termination responses', async () => {
  const active = activeTurn();
  active.commands.set('command', { processId: 'opaque-live', completed: false });
  const listClient = createFakeCodexClient({ [listMethod]: new Error('List unavailable') });
  expect((await failure(stopCodexCommands(listClient, active))).message).toBe('List unavailable');
  for (const result of [null, {}, { terminated: 'true' }, new Error('Termination unavailable')]) {
    const client = createFakeCodexClient({ [listMethod]: emptyPage, [terminateMethod]: () => {
      if (result instanceof Error) throw result;
      return result;
    } });
    expect((await failure(stopCodexCommands(client, active))).message).toMatch(/invalid command termination|Termination unavailable/);
  }
});

async function runningService(responses: Record<string, unknown> = {}) {
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('thread') },
    'turn/start': { turn: { id: 'turn' } }, 'turn/interrupt': {}, [listMethod]: emptyPage,
    [terminateMethod]: { terminated: true }, ...responses });
  const service = createCodexChatService(client);
  const events: Record<string, unknown>[] = [];
  service.onEvent(event => events.push(event));
  await service.sendMessage('Run the command', 'message');
  client.emit('item/started', { threadId: 'thread', turnId: 'turn',
    item: { id: 'command', type: 'commandExecution', processId: 'opaque-live', command: 'long-running-task', status: 'inProgress' } });
  return { service, client, events };
}

test('holds turn completion and deduplicates Stop while process termination is pending', async () => {
  const entered = createDeferred<void>();
  const terminated = createDeferred<unknown>();
  const { service, client, events } = await runningService({ [terminateMethod]: () => {
    entered.resolve(); return terminated.promise;
  } });
  try {
    const first = service.cancelResponse();
    await entered.promise;
    const second = service.cancelResponse();
    client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted', items: [] } });
    expect(service.activeTurns.has('thread')).toBe(true);
    expect(events.some(event => event.type === 'turn-completed')).toBe(false);
    terminated.resolve({ terminated: true });
    expect(await first).toEqual({ requested: true });
    expect(await second).toEqual({ requested: true });
    expect(service.activeTurns.has('thread')).toBe(false);
    expect(events.filter(event => event.type === 'turn-completed')).toHaveLength(1);
    expect(client.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.requests.filter(request => request.method === terminateMethod)).toHaveLength(1);
  } finally { service.stop(); }
});

test('failed Stop keeps deferred completion and retries termination without interrupting the finished turn again', async () => {
  let attempts = 0;
  const { service, client, events } = await runningService({ [terminateMethod]: () => {
    client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted', items: [] } });
    if (++attempts === 1) throw new Error('Try termination again');
    return { terminated: true };
  } });
  try {
    expect((await failure(service.cancelResponse())).message).toContain('Could not stop all work');
    expect(service.activeTurns.has('thread')).toBe(true);
    expect(events.some(event => event.type === 'turn-completed')).toBe(false);
    expect(await service.cancelResponse()).toEqual({ requested: true });
    expect(service.activeTurns.has('thread')).toBe(false);
    expect(client.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(1);
    expect(attempts).toBe(2);
  } finally { service.stop(); }
});

for (const processId of ['opaque-live', null]) {
  test(`finishes Stop after turn interruption when the command completion notification is missing (${processId})`, async () => {
    const { service, client, events } = await runningService({
      'turn/interrupt': () => {
        client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted', items: [] } });
        return {};
      },
      [terminateMethod]: { terminated: false },
    });
    try {
      service.activeTurns.get('thread')!.commands.set('command', { processId, completed: false });
      expect(await service.cancelResponse()).toEqual({ requested: true });
      expect(service.activeTurns.has('thread')).toBe(false);
      expect(events.filter(event => event.type === 'turn-completed')).toHaveLength(1);
    } finally { service.stop(); }
  });
}

test('a terminal turn does not hide a command still present in the running list', async () => {
  let listings = 0;
  const { service, client } = await runningService({
    'turn/interrupt': () => {
      client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted', items: [] } });
      return {};
    },
    [listMethod]: () => ++listings <= 4 ? {
      data: [{ itemId: 'command', processId: 'opaque-live' }], nextCursor: null,
    } : emptyPage,
    [terminateMethod]: { terminated: false },
  });
  try {
    expect(await service.cancelResponse()).toEqual({ requested: true });
    expect(listings).toBeGreaterThan(4);
    expect(client.requests.filter(request => request.method === terminateMethod).length).toBeGreaterThan(1);
  } finally { service.stop(); }
});

for (const turn of [
  { id: 'another-turn', status: 'interrupted' },
  { id: 'turn', status: 'inProgress' },
  { id: 'turn' },
]) {
  test(`does not accept an unrelated or nonterminal completion ${JSON.stringify(turn)}`, async () => {
    const { service, client } = await runningService({
      'turn/interrupt': () => { client.emit('turn/completed', { threadId: 'thread', turn }); return {}; },
      [terminateMethod]: { terminated: false },
    });
    try {
      expect((await failure(service.cancelResponse())).message).toContain('Could not confirm that all commands stopped');
      expect(service.activeTurns.has('thread')).toBe(true);
    } finally { service.stop(); }
  });
}

test('keeps retry available when a command remains running after the turn completes', async () => {
  const active = activeTurn();
  active.commands.set('command', { processId: 'opaque-live', completed: false });
  const client = createFakeCodexClient({
    [listMethod]: { data: [{ itemId: 'command', processId: 'opaque-live' }], nextCursor: null },
    [terminateMethod]: { terminated: false },
  });
  expect((await failure(stopCodexCommands(client, active, () => true))).message).toContain('Press Stop again');
  expect(active.commands.get('command')?.completed).toBe(false);
});

test('tracks completed background command items until their process disappears from the list', async () => {
  let attempts = 0;
  const { service, client } = await runningService({
    [listMethod]: () => attempts >= 2 ? emptyPage : {
      data: [{ itemId: 'command', processId: 'opaque-background' }], nextCursor: null,
    },
    [terminateMethod]: () => { attempts += 1; return { terminated: true }; },
  });
  try {
    client.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: {
      id: 'command', type: 'commandExecution', command: 'long-running-task', status: 'completed',
    } });
    expect(service.activeTurns.get('thread')?.commands.get('command')).toEqual({ processId: 'opaque-live', completed: true });
    expect(await service.cancelResponse()).toEqual({ requested: true });
    expect(attempts).toBe(2);
    expect(client.requests.filter(request => request.method === terminateMethod).every(
      request => request.params.processId === 'opaque-background',
    )).toBe(true);
  } finally { service.stop(); }
});
