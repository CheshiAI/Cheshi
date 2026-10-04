import { expect, test } from 'bun:test';
import { CommandSessions } from './command-stop.ts';
import type { RpcClient } from './app-server-client.ts';
import type { JsonRecord } from './protocol.ts';

const list = 'thread/backgroundTerminals/list', terminate = 'thread/backgroundTerminals/terminate';
const empty = { data: [], nextCursor: null };
function fixture(request: RpcClient['request']) {
  const commands = new CommandSessions();
  const client: RpcClient = { request, subscribe: () => () => {}, onFailure: () => () => {} };
  return { commands, client };
}
async function failure(operation: Promise<void>): Promise<string> {
  try { await operation; } catch (error) { return (error as Error).message; }
  throw new Error('Expected failure');
}

test('terminates this turn foreground and completed-but-backgrounded commands across pages', async () => {
  const stopped: string[] = [];
  const { commands, client } = fixture(async (method, params) => {
    if (method === terminate) { stopped.push(String(params.processId)); return { terminated: true }; }
    expect(method).toBe(list);
    if (stopped.length === 2) return empty;
    return params.cursor ? { data: [{ itemId: 'background', processId: 'opaque-background' }], nextCursor: null }
      : { data: [{ itemId: 'old-turn', processId: 'untouched' }, { itemId: 'foreground', processId: 'opaque-foreground' }], nextCursor: 'next' };
  });
  commands.observe('item/started', { type: 'commandExecution', id: 'foreground' });
  commands.observe('item/completed', { type: 'commandExecution', id: 'background' });
  await commands.stop(client, 'thread');
  expect(stopped).toEqual(['opaque-foreground', 'opaque-background']);
});

test('does not accept terminate acknowledgement until the process disappears from list', async () => {
  let lists = 0, terminations = 0;
  const { commands, client } = fixture(async method => {
    if (method === terminate) { terminations++; return { terminated: true }; }
    return ++lists < 4 ? { data: [{ itemId: 'command', processId: 'opaque' }], nextCursor: null } : empty;
  });
  commands.observe('item/started', { type: 'commandExecution', id: 'command', processId: 'opaque' });
  await commands.stop(client, 'thread');
  expect(lists).toBe(4); expect(terminations).toBe(2);
});

test('accepts natural command exit while termination returns false', async () => {
  const { commands, client } = fixture(async method => method === terminate ? { terminated: false } : empty);
  commands.observe('item/started', { type: 'commandExecution', id: 'command', processId: 'opaque' });
  await commands.stop(client, 'thread');
});

test('rejects persistent processes despite successful termination responses', async () => {
  const { commands, client } = fixture(async method => method === terminate ? { terminated: true }
    : { data: [{ itemId: 'command', processId: 'opaque' }], nextCursor: null });
  commands.observe('item/started', { type: 'commandExecution', id: 'command' });
  expect(await failure(commands.stop(client, 'thread'))).toContain('could not be confirmed');
});

test('validates list identities, pagination and literal termination acknowledgements', async () => {
  const pages: JsonRecord[] = [{}, { data: [], nextCursor: 'repeat' }, { data: [], nextCursor: 2 },
    { data: [{ itemId: 'command', processId: 1 }], nextCursor: null }];
  for (const page of pages) {
    const { commands, client } = fixture(async () => page);
    commands.observe('item/started', { type: 'commandExecution', id: 'command' });
    expect(await failure(commands.stop(client, 'thread'))).toMatch(/Invalid|Repeated|process id/);
  }
  for (const terminated of [undefined, 'true', 1]) {
    const { commands, client } = fixture(async method => method === terminate ? { terminated } : empty);
    commands.observe('item/started', { type: 'commandExecution', id: 'command', processId: 'opaque' });
    expect(await failure(commands.stop(client, 'thread'))).toContain('Invalid command termination');
  }
});

test('never targets stale completed process IDs or requests cleanup for a command-free turn', async () => {
  let calls = 0;
  const { commands, client } = fixture(async method => { calls++; expect(method).toBe(list); return empty; });
  await commands.stop(client, 'thread'); expect(calls).toBe(0);
  commands.observe('item/completed', { type: 'commandExecution', id: 'old', processId: 'stale' });
  await commands.stop(client, 'thread'); expect(calls).toBe(2);
});
