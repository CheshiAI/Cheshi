import { FlashError, flashProviderDetails } from '../flash/client.mts';
import { setTimeout as delay } from 'node:timers/promises';
import type { Binding } from './mailbox.mts';
import type { CollaborationConnection } from './service.mts';
import type { AgentFlashMemory } from '../flash/agent-memory.mts';
import { FlashHistoryChanged, flashId, parseFlashSession, type FlashSession } from '../../../experiments/codex-specialists/src/flash-history.ts';
import { FLASH_TIMEOUT_MS, flashFailure, type FlashRequest } from '../../../experiments/codex-specialists/src/flash-queue.ts';
import { memoryArguments } from '../../../experiments/codex-specialists/src/flash-tools.ts';
import { record } from '../../../experiments/codex-specialists/src/protocol.ts';

export type FlashTransport = (route: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
export function flashHttpTransport(connection: CollaborationConnection): FlashTransport {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Flash requires a loopback worker endpoint.');
  return async (route, body, signal) => {
    const response = await fetch(new URL(route, url), { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body) });
    if (route === '/flash/history' && response.status === 409) { await response.body?.cancel(); throw new FlashHistoryChanged('Flash history changed. Retry.'); }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Start the worker to connect Flash.'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength;
        if (length > 16 * 1024 * 1024) throw new Error('Flash exchange exceeds its limit.'); chunks.push(item.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { await reader.cancel(); }
  };
}

/** Shared by long-lived workers and isolated task containers; the host selects identity. */
export class FlashWorkerConnection {
  private readonly memory: AgentFlashMemory;
  private readonly binding: Binding;
  private readonly transport: FlashTransport;
  private readonly valid: () => boolean;
  private readonly notify: () => void;
  private readonly stream: string;
  private readonly lifetime = new AbortController();
  private revision: string | undefined;
  private flight: Promise<void> | null = null;
  private readonly jobs = new Map<string, { request: FlashRequest; controller: AbortController; result?: unknown; done: Promise<void> }>();
  constructor(memory: AgentFlashMemory, binding: Binding, transport: FlashTransport, valid: () => boolean, notify: () => void, stream = 'worker') {
    this.memory = memory; this.binding = binding; this.transport = transport; this.valid = valid; this.notify = notify; this.stream = stream;
  }
  get busy() { return this.flight !== null || this.jobs.size > 0; }
  private assertCurrent() { this.lifetime.signal.throwIfAborted(); if (!this.valid()) throw new Error('Flash assignment changed.'); }
  private async exchange(route: string, body: unknown, caller = this.lifetime.signal) {
    this.assertCurrent();
    const signal = AbortSignal.any([caller, this.lifetime.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const result = await this.transport(route, body, signal);
    signal.throwIfAborted();
    this.assertCurrent(); return record(result);
  }
  private async synchronize() {
    if (!this.memory.enabled()) return;
    try { await this.memory.withEnabled(signal => this.synchronizeEnabled(signal), this.lifetime.signal); }
    catch (error) { if (!(error instanceof FlashError && error.code === 'disabled')) throw error; }
  }
  private async synchronizeEnabled(signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try { await this.snapshot(signal); return; }
      catch (error) {
        if (!(error instanceof FlashHistoryChanged) || attempt >= 3) throw error;
        await delay(50, undefined, { signal });
      }
    }
  }
  private async snapshot(signal: AbortSignal) {
    const sessions: FlashSession[] = []; let after: string | undefined, revision = this.revision;
    for (;;) {
      const page = await this.exchange('/flash/history', { revision, ...(after ? { after } : {}) }, signal);
      if (typeof page.revision !== 'string' || !/^[a-f0-9]{64}$/.test(page.revision)) throw new Error('Invalid Flash history revision.');
      if (page.unchanged === true) { if (after || page.revision !== this.revision) throw new Error('Invalid unchanged Flash history.'); return; }
      if (after && page.revision !== revision) throw new FlashHistoryChanged('Flash history changed. Retry.');
      revision = page.revision;
      if (page.session !== null) {
        const session = parseFlashSession(page.session);
        if (session.threadId <= (after ?? '')) throw new Error('Invalid Flash history order.');
        sessions.push(session);
      }
      if (page.next === null) break;
      const next = flashId(page.next);
      if (next <= (after ?? '') || next !== sessions.at(-1)?.threadId || sessions.length >= 10000) throw new Error('Invalid Flash history cursor.');
      after = next;
    }
    this.assertCurrent();
    signal.throwIfAborted();
    await this.memory.archive.replace(this.binding, this.stream, sessions, () => this.valid() && !this.lifetime.signal.aborted && !signal.aborted);
    signal.throwIfAborted();
    this.assertCurrent(); this.revision = revision;
  }
  tick(): Promise<void> {
    this.flight ??= this.poll().finally(() => { this.flight = null; });
    return this.flight;
  }
  private async poll() {
    await this.synchronize();
    const results = [...this.jobs.values()].filter(j => j.result !== undefined).map(j => ({ id: j.request.id, result: j.result }));
    const body = await this.exchange('/flash/exchange', { protocol: 1, results });
    if (body.protocol !== 1 || !Array.isArray(body.requests) || body.requests.length > 4) throw new Error('Invalid Flash exchange.');
    const requests = body.requests.map(value => {
      const r = record(value);
      flashId(r.id); flashId(r.threadId); flashId(r.turnId);
      if (typeof r.tool !== 'string' || typeof r.deadline !== 'number' || !Number.isSafeInteger(r.deadline) || r.deadline <= Date.now() || r.deadline > Date.now() + FLASH_TIMEOUT_MS + 5000) throw new Error('Invalid Flash request.');
      return { id: r.id as string, threadId: r.threadId as string, turnId: r.turnId as string, tool: r.tool, deadline: r.deadline, args: memoryArguments(r.tool, r.args) };
    });
    for (const [id, job] of this.jobs) if (!requests.some(r => r.id === id)) { job.controller.abort(); this.jobs.delete(id); }
    for (const request of requests) {
      const previous = this.jobs.get(request.id);
      if (previous) { if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error('Conflicting Flash request.'); continue; }
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(Math.max(1, request.deadline - Date.now()))]);
      const job = { request, controller, result: undefined as unknown, done: Promise.resolve() };
      job.done = this.memory.execute(this.binding, request, signal).then(result => {
        job.result = this.valid() && !signal.aborted ? result : flashFailure('Flash request expired or assignment changed.');
      }, error => { job.result = flashRelayFailure(error, signal); }).finally(() => { if (!this.lifetime.signal.aborted) this.notify(); });
      this.jobs.set(request.id, job);
    }
  }
  async flush() { await this.flight; await this.synchronize(); }
  async dispose() { this.lifetime.abort(); for (const job of this.jobs.values()) job.controller.abort(); await Promise.allSettled([this.flight, ...[...this.jobs.values()].map(j => j.done)]); this.jobs.clear(); }
}

export class AgentFlashRelay {
  private readonly memory: AgentFlashMemory;
  private readonly notify: (binding: Binding) => void;
  private readonly workers = new Map<string, { key: string; bridge: FlashWorkerConnection }>();
  constructor(memory: AgentFlashMemory, notify: (binding: Binding) => void) { this.memory = memory; this.notify = notify; }
  get busy() { return [...this.workers.values()].some(w => w.bridge.busy); }
  async cancel(id: string) { const worker = this.workers.get(id); this.workers.delete(id); await worker?.bridge.dispose(); }
  async tick(binding: Binding, connection: CollaborationConnection, valid: () => boolean) {
    const key = JSON.stringify([binding, connection]);
    if (this.workers.get(binding.id)?.key !== key) {
      await this.cancel(binding.id);
      if (!valid()) return;
      this.workers.set(binding.id, { key, bridge: new FlashWorkerConnection(this.memory, binding, flashHttpTransport(connection), valid, () => this.notify(binding)) });
    }
    await this.workers.get(binding.id)!.bridge.tick();
  }
  async dispose() { await Promise.all([...this.workers.keys()].map(id => this.cancel(id))); }
}

/** Only known categories cross the worker boundary, never provider messages or raw input. */
export function flashRelayFailure(error: unknown, signal: AbortSignal) {
  if (error instanceof FlashError && error.code === 'disabled') {
    return { ...flashFailure('Flash is off. Enable it in Settings > Flash to use memory.'), code: 'disabled', retryable: false };
  }
  const known = new Set(['invalid_summary', 'invalid_model_json', 'model_unavailable', 'invalid_ranking',
    'stale_source', 'turns_too_large', 'input_too_large', 'timeout', 'canceled', 'unavailable', 'not_ready', 'syncing']);
  const code = signal.aborted ? 'canceled' : error instanceof FlashError && known.has(error.code) ? error.code : 'unavailable';
  return { ...flashFailure(`Flash could not complete (${code}). Do not infer missing history.`), code,
    retryable: ['timeout', 'model_unavailable', 'not_ready', 'syncing', 'stale_source'].includes(code),
    ...flashProviderDetails(error, signal) };
}
