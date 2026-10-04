import { expect, test } from 'bun:test';
import { ExecutionHealth } from './execution-health.ts';
import type { RpcClient } from './app-server-client.ts';
import { createDeferred, type JsonRecord, type Notification } from './protocol.ts';

function fixture() {
  let now = Date.parse('2026-10-04T00:00:00Z');
  const calls: { method: string; params: JsonRecord }[] = [];
  let read: () => Promise<JsonRecord> = async () => ({ thread: { id: 'thread' } });
  const client: RpcClient = {
    request: (method, params) => { calls.push({ method, params }); return read(); },
    subscribe: () => () => {}, onFailure: () => () => {},
  };
  return { health: new ExecutionHealth('task', () => now), client, calls,
    advance: (ms: number) => { now += ms; }, read: (fn: typeof read) => { read = fn; } };
}
const event = (method: string, turnId = 'turn'): Notification => ({ method, params: {
  threadId: 'thread', turnId, delta: 'private reasoning must not be exposed', item: { type: 'commandExecution' },
} });

test('metadata probes are throttled and never count as model progress', async () => {
  const f = fixture(), before = f.health.snapshot();
  await f.health.check(f.client, null); expect(f.calls).toHaveLength(0);
  await f.health.check(f.client, 'thread');
  f.advance(119_999); await f.health.check(f.client, 'thread');
  expect(f.calls).toEqual([{ method: 'thread/read', params: { threadId: 'thread', includeTurns: false } }]);
  f.advance(1); await f.health.check(f.client, 'thread'); expect(f.calls).toHaveLength(2);
  expect(f.health.snapshot()).toMatchObject({ engineStatus: 'responding', lastActivityAt: before.lastActivityAt });
  f.advance(86_400_000); expect(f.health.snapshot().lastActivityAt).toBe(before.lastActivityAt);
});

test('only active-turn notifications update activity and no event contents are exposed', () => {
  const f = fixture(), before = f.health.snapshot().lastActivityAt;
  f.advance(500);
  f.health.receive(event('item/reasoning/textDelta', 'foreign'), 'thread', 'turn');
  f.health.receive(event('item/reasoning/textDelta'), 'other-thread', 'turn');
  expect(f.health.snapshot().lastActivityAt).toBe(before);
  f.health.receive(event('item/reasoning/textDelta'), 'thread', 'turn');
  expect(f.health.snapshot().lastActivity).toBe('model');
  expect(f.health.snapshot().lastActivityAt).not.toBe(before);
  f.health.receive(event('item/started'), 'thread', 'turn');
  expect(f.health.snapshot().lastActivity).toBe('tool');
  expect(JSON.stringify(f.health.snapshot())).not.toContain('private reasoning');
});

test('failed and malformed probes remain unconfirmed and a later success recovers', async () => {
  const f = fixture();
  f.read(async () => { throw new Error('transport probe timeout'); });
  await f.health.check(f.client, 'thread');
  expect(f.health.snapshot()).toMatchObject({ engineStatus: 'unconfirmed', lastResponsiveAt: null });
  f.advance(120_000); f.read(async () => ({ thread: { id: 'foreign' } }));
  await f.health.check(f.client, 'thread'); expect(f.health.snapshot().engineStatus).toBe('unconfirmed');
  f.advance(120_000); f.read(async () => ({ thread: { id: 'thread' } }));
  await f.health.check(f.client, 'thread'); expect(f.health.snapshot().engineStatus).toBe('responding');
  expect(f.calls.every(c => c.method === 'thread/read')).toBe(true);
});

test('a slow probe cannot accumulate concurrent requests or claim a current response', async () => {
  const f = fixture(), response = createDeferred<JsonRecord>();
  await f.health.check(f.client, 'thread');
  f.advance(120_000); f.read(() => response.promise);
  const pending = f.health.check(f.client, 'thread');
  f.advance(30_000);
  expect(f.health.check(f.client, 'thread')).toBe(pending);
  expect(f.calls).toHaveLength(2); expect(f.health.snapshot().engineStatus).toBe('unconfirmed');
  f.health.activity('tool'); expect(f.health.snapshot().engineStatus).toBe('unconfirmed');
  response.resolve({ thread: { id: 'thread' } }); await pending;
  expect(f.health.snapshot().engineStatus).toBe('responding');
});
