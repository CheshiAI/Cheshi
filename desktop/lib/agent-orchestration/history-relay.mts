import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Binding } from './mailbox.mts';
import type { CollaborationConnection } from './service.mts';
import { createAgentHistory, requestWorkerHistory, type HistoryProof, type HistoryTransport } from './history-source.mts';
import { createHistoryRecallEvaluator, type RecallEvaluator } from '../chat-history-recall-model.mts';
import { recordValue } from '../codex-service-utils.mts';

export interface AgentHistoryOptions {
  enabled(): boolean;
  getKey(): string | null;
  subscribe?(listener: () => void): () => void;
  transport?: HistoryTransport;
  evaluate?: RecallEvaluator;
}
type Request = { id: string; taskId: string; threadId: string; turnId: string; tool: string; args: unknown; deadline: number };
type Job = { scope: string; request: Request; status: 'running' | 'done'; result?: unknown; proof?: HistoryProof };
const failed = (error: string) => ({ status: 'error', error, usage: 'unknown' });
function parseRequest(value: unknown): Request {
  const raw = recordValue(value);
  if (!raw || !['id', 'taskId', 'threadId', 'turnId'].every(k => typeof raw[k] === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(raw[k] as string))
    || !['history_search', 'history_read'].includes(String(raw.tool)) || !recordValue(raw.args)
    || typeof raw.deadline !== 'number' || !Number.isFinite(raw.deadline) || JSON.stringify(raw.args).length > 4000) throw new Error('Invalid worker history request.');
  return { id: raw.id as string, taskId: raw.taskId as string, threadId: raw.threadId as string, turnId: raw.turnId as string,
    tool: raw.tool as string, args: raw.args, deadline: raw.deadline };
}
export class AgentHistoryRelay {
  private readonly filename: string;
  private readonly options: AgentHistoryOptions;
  private jobs: Job[] | null = null;
  private readonly active = new Map<string, AbortController>();
  private readonly polling = new Map<string, Promise<void>>();
  private readonly processing = new Set<Promise<void>>();
  private readonly sources = new Map<string, { endpoint: string; source: ReturnType<typeof createAgentHistory> }>();
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private readonly lifetime = new AbortController();
  constructor(filename: string, options: AgentHistoryOptions) { this.filename = filename; this.options = options; }
  private load() {
    if (this.jobs) return this.jobs;
    const raw: unknown = existsSync(this.filename) ? JSON.parse(readFileSync(this.filename, 'utf8')) : [];
    if (!Array.isArray(raw) || raw.length > 256 || raw.some(j => !j || typeof j.scope !== 'string' || !['running', 'done'].includes(j.status))) throw new Error('Invalid history relay journal.');
    const jobs = raw.map((j: Job) => ({ ...j, request: parseRequest(j.request),
      ...(j.status === 'running' ? { status: 'done' as const, result: failed('Host restarted during recall; usage is unknown. Retry explicitly.'), proof: undefined } : {}) }));
    this.save(jobs);
    this.unsubscribe = this.options.subscribe?.(() => {
      if (this.options.enabled() !== true) {
        for (const controller of this.active.values()) controller.abort();
        this.sources.clear();
      }
    });
    return jobs;
  }
  private save(jobs: Job[]) {
    if (this.jobs && JSON.stringify(this.jobs) === JSON.stringify(jobs)) return;
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(jobs), { mode: 0o600, flush: true });
    renameSync(`${this.filename}.tmp`, this.filename); this.jobs = jobs;
  }
  private update(scope: string, id: string, patch: Partial<Job>) {
    this.save(this.load().map(j => j.scope === scope && j.request.id === id ? { ...j, ...patch } : j));
  }
  tick(binding: Binding, connection: CollaborationConnection, valid: () => boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const scope = createHash('sha256').update(JSON.stringify([binding, connection.token])).digest('hex');
    const existing = this.polling.get(scope);
    if (existing) return existing;
    const promise = this.poll(scope, connection, valid).finally(() => this.polling.delete(scope));
    this.polling.set(scope, promise); return promise;
  }
  private async poll(scope: string, connection: CollaborationConnection, valid: () => boolean) {
    this.load();
    const allowed = () => !this.disposed && valid() && this.options.enabled() === true;
    const transport = this.options.transport ?? requestWorkerHistory;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20_000)]);
    const cached = this.sources.get(scope);
    let source = cached?.endpoint === connection.endpoint ? cached.source : undefined;
    if (!source) {
      for (const [key, controller] of this.active) if (key.startsWith(`${scope}:`)) controller.abort();
      source = createAgentHistory(connection, this.options.evaluate ?? createHistoryRecallEvaluator({ getKey: this.options.getKey }), transport);
      this.sources.set(scope, { endpoint: connection.endpoint, source });
      if (this.sources.size > 64) this.sources.delete(this.sources.keys().next().value!);
    }
    const completed = this.load().filter(j => j.scope === scope && j.status === 'done').slice(0, 4);
    const results = [];
    for (const job of completed) {
      const verified = allowed() && (!job.proof || await source.verify(job.proof, signal));
      results.push({ id: job.request.id, result: verified ? job.result : failed('History is disabled or its source changed. Search again.') });
    }
    if (!valid() || this.disposed) return;
    const response = recordValue(await transport(connection, '/history/exchange', { protocol: 1, enabled: allowed(), results }, signal));
    if (response?.protocol !== 1 || !Array.isArray(response.requests) || response.requests.length > 4 || !Array.isArray(response.acknowledged)) throw new Error('Invalid history relay response.');
    const acknowledged = response.acknowledged;
    if (acknowledged.length > 256 || acknowledged.some(id => typeof id !== 'string')) throw new Error('Invalid recall acknowledgements.');
    const requests = response.requests.map(parseRequest), pending = new Set(requests.map(r => r.id));
    for (const job of this.load().filter(j => j.scope === scope)) {
      if (!pending.has(job.request.id)) this.active.get(`${scope}:${job.request.id}`)?.abort();
    }
    // Keep a bounded deduplication journal. Acknowledged completed results can be pruned first.
    this.save(this.load().filter(j => j.request.deadline > Date.now() - 300_000
      && (j.scope !== scope || !acknowledged.includes(j.request.id))));
    for (const request of requests) {
      const prior = this.load().find(j => j.scope === scope && j.request.id === request.id);
      if (prior) {
        if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('Conflicting recall request id.');
        continue;
      }
      if (!allowed() || this.active.size >= 4) continue;
      if (this.load().length >= 256) throw new Error('History relay journal is full.');
      this.save([...this.load(), { scope, request, status: 'running' }]);
      const controller = new AbortController(), key = `${scope}:${request.id}`;
      this.active.set(key, controller);
      const execution = this.run(scope, request, source, controller, allowed).finally(() => { this.active.delete(key); this.processing.delete(execution); });
      this.processing.add(execution);
      // Persistence failures must not become unhandled rejections or silently replay provider calls.
      void execution.catch(() => controller.abort());
    }
  }
  private async run(scope: string, request: Request, source: ReturnType<typeof createAgentHistory>, controller: AbortController, allowed: () => boolean) {
    const remaining = request.deadline - Date.now();
    if (remaining <= 0 || remaining > 125_000) { this.update(scope, request.id, { status: 'done', result: failed('Recall deadline expired or invalid.') }); return; }
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
    try {
      if (!allowed()) throw new Error('Recall unavailable.');
      const result = await source.call(request.tool, request.args, request.threadId, signal);
      signal.throwIfAborted();
      this.update(scope, request.id, { status: 'done', ...(allowed() ? result : { result: failed('Recall access changed.') }) });
    } catch { this.update(scope, request.id, { status: 'done', result: failed('Recall failed or was canceled. Usage may be unknown.') }); }
  }
  get busy() { return this.active.size > 0 || this.polling.size > 0; }
  async dispose() {
    this.disposed = true; this.lifetime.abort(); this.unsubscribe?.();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.polling.values(), ...this.processing]);
    this.sources.clear();
  }
}
