import { createHash } from 'node:crypto';
import type { Binding } from './mailbox.mts';
import type { CollaborationConnection } from './service.mts';
import type { CodeGraphQuery } from './codegraph-source.mts';
import { codegraphArguments } from '../../../experiments/codex-specialists/src/codegraph-tools.ts';
import { codegraphFailure, type CodeGraphRequest } from '../../../experiments/codex-specialists/src/codegraph-queue.ts';

type Transport = (connection: CollaborationConnection, body: unknown, signal: AbortSignal) => Promise<unknown>;
const exchange: Transport = async (connection, body, signal) => {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('CodeGraph requires a loopback worker endpoint.');
  const response = await fetch(new URL('/codegraph/exchange', url), { method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Start the worker to connect CodeGraph.'); }
  return await response.json() as unknown;
};
type Job = { request: CodeGraphRequest; controller: AbortController; result?: unknown };
export class AgentCodeGraphRelay {
  private readonly query: CodeGraphQuery;
  private readonly notify: (binding: Binding) => void;
  private readonly transport: Transport;
  private readonly jobs = new Map<string, Map<string, Job>>();
  private readonly polling = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  constructor(query: CodeGraphQuery, notify: (binding: Binding) => void, transport: Transport = exchange) { this.query = query; this.notify = notify; this.transport = transport; }
  get busy() { return this.running.size > 0 || this.polling.size > 0; }
  tick(binding: Binding, connection: CollaborationConnection, valid: () => boolean) {
    const scope = createHash('sha256').update(JSON.stringify([binding, connection])).digest('hex');
    const pending = this.polling.get(scope); if (pending) return pending;
    const run = this.poll(scope, binding, connection, valid).finally(() => this.polling.delete(scope));
    this.polling.set(scope, run); return run;
  }
  private async poll(scope: string, binding: Binding, connection: CollaborationConnection, valid: () => boolean) {
    if (this.lifetime.signal.aborted || !valid()) return;
    for (const [key, jobs] of this.jobs) {
      for (const [id, job] of jobs) if (job.request.deadline <= Date.now()) { job.controller.abort(); jobs.delete(id); }
      if (!jobs.size) this.jobs.delete(key);
    }
    const jobs = this.jobs.get(scope) ?? new Map<string, Job>();
    const results = [...jobs.values()].filter(j => j.result !== undefined).map(j => ({ id: j.request.id, result: j.result }));
    const raw = await this.transport(connection, { protocol: 1, results }, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]));
    const body = raw as { protocol?: number; requests?: CodeGraphRequest[] };
    if (body?.protocol !== 1 || !Array.isArray(body.requests) || body.requests.length > 4) throw new Error('Invalid CodeGraph exchange.');
    if (!valid() || this.lifetime.signal.aborted) { for (const job of jobs.values()) job.controller.abort(); this.jobs.delete(scope); return; }
    for (const [id, job] of jobs) if (!body.requests.some(r => r.id === id)) { job.controller.abort(); jobs.delete(id); }
    for (const request of body.requests) {
      if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.id)
        || !Number.isSafeInteger(request.deadline) || request.deadline <= Date.now() || request.deadline > Date.now() + 65_000) throw new Error('Invalid CodeGraph request.');
      const args = codegraphArguments(request.tool, request.args);
      const prior = jobs.get(request.id);
      if (prior) { if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('Conflicting CodeGraph request.'); continue; }
      if (this.running.size >= 4 || this.jobs.size >= 64 && !this.jobs.has(scope)) continue;
      const job: Job = { request, controller: new AbortController() }; jobs.set(request.id, job); this.jobs.set(scope, jobs);
      const signal = AbortSignal.any([job.controller.signal, this.lifetime.signal, AbortSignal.timeout(Math.max(1, request.deadline - Date.now()))]);
      const run = this.query(binding.workspace, request.tool, args, signal).then(result => {
        job.result = valid() && !signal.aborted ? result : codegraphFailure('CodeGraph assignment changed or request expired.');
      }, () => { job.result = codegraphFailure('CodeGraph is unavailable. Use scoped project reads.'); }).finally(() => {
        this.running.delete(run); if (!this.lifetime.signal.aborted) this.notify(binding);
      });
      this.running.add(run);
    }
    if (!jobs.size) this.jobs.delete(scope);
  }
  async dispose() { this.lifetime.abort(); for (const jobs of this.jobs.values()) for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...this.polling.values(), ...this.running]); this.jobs.clear(); }
}
