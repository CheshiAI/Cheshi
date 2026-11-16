import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlashControl } from '../lib/flash/control.mts';
import { createSettingsService } from '../lib/settings-service.mts';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { AgentFlashMemory } from '../lib/flash/agent-memory.mts';
import { FlashWorkerConnection } from '../lib/agent-orchestration/flash-relay.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import type { FlashRequest } from '../../experiments/codex-specialists/src/flash-queue.ts';
import type { FlashHost } from '../lib/flash/runtime.mts';
import { flashStatusPresentation } from '../frontend/src/features/chat/flashMemoryStatus.ts';
import { account, deferred, fixtureSummary, flashFixture, history, readRequest, rejection, session } from './flash-test-helpers.ts';

async function fixture(createHost: () => FlashHost) {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-flash-control-'));
  const settings = createSettingsService({ settingsPath: join(directory, 'settings.json') });
  const control = new FlashControl(settings, createHost);
  return { directory, settings, control, close: async () => {
    await control.dispose(); await rm(directory, { recursive: true, force: true });
  } };
}
const caller = () => new AbortController().signal;

test('shared leases cannot start Flash while off and wait for shutdown before re-enabling', async () => {
  const release = deferred<void>();
  const entered = deferred<void>();
  const resume = deferred<void>();
  let starts = 0, releases = 0;
  const f = await fixture(() => {
    starts++;
    return { transaction: async (operation, signal) => {
      signal.throwIfAborted(); return operation({ socketPath: '/unused', token: 'fixture' });
    }, release: async () => { releases++; await release.promise; } };
  });
  const first = f.control.acquire(), second = f.control.acquire();
  try {
    expect(await rejection(() => first.transaction(async () => 1, caller()))).toMatchObject({ code: 'disabled' });
    expect(starts).toBe(0);
    f.settings.setFlashEnabled(true);
    expect(await first.transaction(async () => 1, caller())).toBe(1);
    expect(await second.transaction(async () => 2, caller())).toBe(2);
    expect(starts).toBe(1);
    const pending = rejection(() => f.control.run(async signal => {
      entered.resolve(); await resume.promise; signal.throwIfAborted(); return 'late';
    }, caller()));
    await entered.promise;
    f.settings.setFlashEnabled(false);
    expect(await pending).toMatchObject({ code: 'disabled' });
    f.settings.setFlashEnabled(true);
    const next = second.transaction(async () => 3, caller());
    await Promise.resolve(); await Promise.resolve();
    expect(starts).toBe(1);
    release.resolve(); resume.resolve();
    expect(await next).toBe(3);
    expect(starts).toBe(2); expect(releases).toBe(1);
    await first.release();
    expect(await second.transaction(async () => 4, caller())).toBe(4);
    expect((await rejection(() => first.transaction(async () => 5, caller()))).name).toBe('AbortError');
  } finally { release.resolve(); resume.resolve(); await f.close(); }
});

test('all sessions stay off without syncing, then reconcile deletions when re-enabled', async () => {
  const wire = await flashFixture();
  let starts = 0, listed = 0, removed = false;
  const f = await fixture(() => { starts++; return wire.host; });
  const makeMemory = () => new FlashSessionMemory({ workspace: '/workspace', control: f.control, host: f.control.acquire(),
    source: { list: async () => { listed++; return { sessions: removed ? [] : [session()] }; }, read: async () => history() } });
  const first = makeMemory(), second = makeMemory();
  try {
    first.accounts(account()); second.accounts(account());
    first.changed({ type: 'turn-completed' });
    expect(first.retry().state).toBe('disabled');
    await first.remove(['s']);
    expect(await rejection(() => first.execute('memory_search', { query: 'q' }, 'current', caller()))).toMatchObject({ code: 'disabled' });
    expect(listed).toBe(0); expect(starts).toBe(0);
    expect(flashStatusPresentation(first.status())).toEqual({ label: 'Off', detail: '', retryable: false });
    f.settings.setFlashEnabled(true);
    expect(second.status().state).toBe('preparing');
    await first.synchronize(); await second.synchronize();
    expect(first.status().state).toBe('ready'); expect(second.status().state).toBe('ready');
    f.settings.setFlashEnabled(false);
    expect(first.status().state).toBe('disabled'); expect(second.status().state).toBe('disabled');
    const before = wire.methods.length;
    removed = true;
    await first.remove(['s']); first.changed({ type: 'sessions-deleted', threadIds: ['s'] });
    expect(wire.methods.length).toBe(before);
    f.settings.setFlashEnabled(true);
    await first.synchronize();
    expect(wire.methods).toContain('source.delete');
    expect(first.status()).toMatchObject({ state: 'ready', total: 0, waiting: 0 });
  } finally { await first.dispose(); await second.dispose(); await f.close(); await wire.close(); }
});

test('switching off cancels an active summary and prevents a late ready/error publication', async () => {
  const wire = await flashFixture(), entered = deferred<void>(), resume = deferred<void>();
  const f = await fixture(() => wire.host);
  f.settings.setFlashEnabled(true);
  const memory = new FlashSessionMemory({ workspace: '/workspace', control: f.control, host: f.control.acquire(),
    source: { list: async () => ({ sessions: [session()] }), read: async () => history() },
    summarize: async value => { entered.resolve(); await resume.promise; return fixtureSummary(value); } });
  try {
    memory.accounts(account());
    const pending = rejection(() => memory.execute('memory_read', readRequest(), 'current', caller()));
    await entered.promise;
    f.settings.setFlashEnabled(false);
    expect(await pending).toMatchObject({ code: 'disabled' });
    resume.resolve();
    expect(memory.status()).toMatchObject({ state: 'disabled', waiting: 0, error: null });
    expect(memory.retry().state).toBe('disabled');
  } finally { resume.resolve(); await memory.dispose(); await f.close(); await wire.close(); }
});

test('disabling a waiting search cancels synchronization and re-enable starts with current sources', async () => {
  const wire = await flashFixture(), entered = deferred<void>(), resume = deferred<void>();
  const f = await fixture(() => wire.host);
  f.settings.setFlashEnabled(true);
  let blocked = true;
  const memory = new FlashSessionMemory({ workspace: '/workspace', control: f.control, host: f.control.acquire(),
    source: { list: async () => {
      if (blocked) { entered.resolve(); await resume.promise; }
      return { sessions: [session()] };
    }, read: async () => history() } });
  try {
    memory.accounts(account());
    const pending = rejection(() => memory.execute('memory_search', { query: 'q' }, 'current', caller()));
    await entered.promise;
    expect(memory.status().waiting).toBe(1);
    f.settings.setFlashEnabled(false);
    expect(await pending).toMatchObject({ code: 'disabled' });
    expect(memory.status()).toMatchObject({ state: 'disabled', waiting: 0, error: null });
    blocked = false; resume.resolve();
    f.settings.setFlashEnabled(true);
    await memory.synchronize();
    expect(memory.status()).toMatchObject({ state: 'ready', total: 1, error: null });
  } finally { resume.resolve(); await memory.dispose(); await f.close(); await wire.close(); }
});

test('a failed Flash startup can be switched off without retrying and retried after enabling', async () => {
  let starts = 0;
  const f = await fixture(() => ({ transaction: async () => { starts++; throw new Error('Missing executable'); }, release: async () => {} }));
  const memory = new FlashSessionMemory({ workspace: '/workspace', control: f.control, host: f.control.acquire(),
    source: { list: async () => ({ sessions: [] }), read: async () => history() } });
  try {
    memory.accounts(account()); f.settings.setFlashEnabled(true);
    await rejection(() => memory.synchronize());
    expect(memory.status().state).toBe('error');
    f.settings.setFlashEnabled(false);
    expect(memory.retry().state).toBe('disabled'); expect(starts).toBe(1);
    f.settings.setFlashEnabled(true);
    await rejection(() => memory.synchronize());
    expect(starts).toBe(2);
  } finally { await memory.dispose(); await f.close(); }
});

test('turning Flash off aborts Homie history transfer and resumes it on the next enabled poll', async () => {
  const entered = deferred<void>();
  let historyCalls = 0;
  let historySignal: AbortSignal | undefined;
  const f = await fixture(() => { throw new Error('History must not start the model'); });
  f.settings.setFlashEnabled(true);
  const memory = new AgentFlashMemory(f.directory, () => true, undefined, f.control);
  const binding = bindingFor('/workspace', 'docker:local', 'alice', 'account');
  const bridge = new FlashWorkerConnection(memory, binding, async (route, _body, signal) => {
    if (route === '/flash/history') {
      historyCalls++;
      if (historyCalls === 1) {
        historySignal = signal; entered.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { revision: 'a'.repeat(64), session: null, next: null };
    }
    return { protocol: 1, requests: [] };
  }, () => true, () => {});
  try {
    const poll = bridge.tick(); await entered.promise;
    f.settings.setFlashEnabled(false);
    await poll;
    expect(historySignal?.aborted).toBe(true);
    await bridge.tick(); expect(historyCalls).toBe(1);
    f.settings.setFlashEnabled(true);
    await bridge.tick(); expect(historyCalls).toBe(2);
  } finally { await bridge.dispose(); await memory.dispose(); await f.close(); }
});

test('Homies skip history synchronization while off and receive a disabled tool result', async () => {
  let starts = 0;
  const f = await fixture(() => { starts++; throw new Error('Must not start'); });
  const memory = new AgentFlashMemory(f.directory, () => true, undefined, f.control);
  const binding = bindingFor('/workspace', 'docker:local', 'alice', 'account');
  const request: FlashRequest = { id: 'request', tool: 'memory_search', args: { query: 'q' }, threadId: 'current',
    turnId: 'turn', deadline: Date.now() + 60_000 };
  const routes: string[] = [], results: unknown[] = [];
  const bridge = new FlashWorkerConnection(memory, binding, async (route, body) => {
    routes.push(route);
    results.push(...(body as { results: unknown[] }).results);
    return { protocol: 1, requests: results.length ? [] : [request] };
  }, () => true, () => {});
  try {
    await bridge.tick();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await bridge.tick(); await bridge.flush();
    expect(routes).not.toContain('/flash/history');
    expect(starts).toBe(0);
    expect(results).toMatchObject([{ id: 'request', result: { code: 'disabled', retryable: false } }]);
  } finally { await bridge.dispose(); await memory.dispose(); await f.close(); }
});
