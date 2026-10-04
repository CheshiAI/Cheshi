import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { IdleLifecycle } from './idle-lifecycle.ts';
import type { RpcClient } from './app-server-client.ts';
import { createDeferred } from './protocol.ts';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fails(operation: Promise<unknown>, text: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain(text);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cheshi-idle-')); directories.push(dir);
  const store = new AgentStore(dir), calls: string[] = [];
  let busy = false, commands = false, now = 1000;
  const client: RpcClient = { subscribe: () => () => {}, onFailure: () => () => {}, request: async (method, params) => {
    calls.push(`${method}:${params.threadId ?? params.cursor ?? ''}`);
    if (method === 'thread/loaded/list') return params.cursor ? { data: ['old-thread'], nextCursor: null } : { data: ['latest-thread'], nextCursor: 'next' };
    if (method === 'thread/backgroundTerminals/list') return { data: commands && params.threadId === 'old-thread' ? [{ processId: 'alive' }] : [], nextCursor: null };
    throw new Error('Unexpected RPC');
  } };
  const gate = new IdleLifecycle({ store, client, blocked: () => busy, now: () => now });
  return { store, gate, calls, client, setBusy: (v: boolean) => { busy = v; }, setCommands: (v: boolean) => { commands = v; }, advance: () => { now += 60001; } };
}
test('preparation checks all live threads and never terminates a background command', async () => {
  const f = fixture(); f.setCommands(true);
  await fails(f.gate.prepare(), 'Background command'); expect(f.gate.draining).toBe(false);
  expect(f.calls).toContain('thread/backgroundTerminals/list:old-thread');
  expect(f.calls.some(c => c.includes('terminate'))).toBe(false);
  f.setCommands(false);
  const receipt = await f.gate.prepare(); expect(receipt.idle).toBe(true);
  expect(() => f.gate.enter()).toThrow('preparing');
  await f.gate.commit({ lease: receipt.lease });
  expect(() => f.gate.cancel()).toThrow('committed');
});
test('busy work, unknown outcomes and unacknowledged messages prevent idle sleep without task deadlines', async () => {
  const f = fixture(); f.setBusy(true); f.advance();
  expect(f.gate.probe().idle).toBe(false); f.setBusy(false);
  f.store.create('task', 'Long running'); expect(f.gate.probe().idle).toBe(false);
  f.store.update('task', { status: 'unknown' }); expect(f.gate.probe().idle).toBe(false);
  f.store.update('task', { status: 'waiting' });
  f.store.transaction(s => { s.collaboration.outgoing.push({ id: 'q', questionId: 'q', taskId: 'task', from: 'dev', to: 'planner', kind: 'question', text: 'Policy?' }); });
  expect(f.gate.probe().idle).toBe(false);
  f.store.transaction(s => { s.collaboration.acknowledged.push('q'); s.collaboration.questionDeadlines = { q: new Date(999999).toISOString() }; });
  expect(f.gate.probe()).toMatchObject({ idle: true, nextWakeAt: 999999 });
  await f.gate.prepare(); f.gate.cancel();
  expect(f.store.task('task')?.status).toBe('waiting');
});
test('lost prepare expires, stale commits fail and new admissions invalidate a pending inventory check', async () => {
  const f = fixture(); const receipt = await f.gate.prepare(); f.advance();
  expect(f.gate.draining).toBe(false); await fails(f.gate.commit({ lease: receipt.lease }), 'Invalid sleep lease');
  const check = createDeferred<Record<string, unknown>>();
  f.client.request = async () => check.promise;
  const preparation = f.gate.prepare(); f.gate.cancel();
  const leave = f.gate.enter(); check.resolve({ data: [], nextCursor: null });
  await fails(preparation, 'became busy'); leave();
});
test('in-flight admission and an expired question keep the worker awake', async () => {
  const f = fixture(); const leave = f.gate.enter();
  await fails(f.gate.prepare(), 'unfinished'); leave();
  f.store.transaction(s => { s.collaboration.outgoing.push({ id: 'q', questionId: 'q', taskId: 'task', from: 'dev', to: 'planner', kind: 'question', text: 'Policy?' });
    s.collaboration.acknowledged.push('q'); s.collaboration.questionDeadlines = { q: new Date(1).toISOString() }; });
  expect(f.gate.probe()).toMatchObject({ idle: false, nextWakeAt: 1 });
});

test('unresolved application storage fails closed even when no model turn is active', async () => {
  const f = fixture();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const directory = join(f.store.directory, 'integrations', 'pending'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'application.json'), JSON.stringify({ status: 'applying' }));
  expect(f.gate.probe().idle).toBe(true);
  let error: unknown; try { await f.gate.prepare(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error); expect(f.gate.draining).toBe(false);
  expect(f.calls).toHaveLength(0);
});
