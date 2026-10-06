import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Binding } from './mailbox.mts';
import type { CollaborationConnection } from './service.mts';
export type CustomToolQuery = (binding: Binding, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
import { record } from '../../../experiments/codex-specialists/src/protocol.ts';
import { customToolFailure, type CustomToolRequest } from '../../../experiments/codex-specialists/src/custom-tool-queue.ts';

type Transport = (connection: CollaborationConnection, body: unknown, signal: AbortSignal) => Promise<unknown>;
const exchange: Transport = async (connection, body, signal) => {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('CustomTool requires a loopback worker endpoint.');
  const response = await fetch(new URL('/custom-tools/exchange', url), { method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Start the worker to connect CustomTool.'); }
  return await response.json() as unknown;
};
type Job = { request: CustomToolRequest; controller: AbortController; result?: unknown };
export class AgentCustomToolRelay {
  private readonly receipts = new Map<string, { deadline: number; result?: unknown }>();
  private readonly filename?: string;
  private readonly query: CustomToolQuery;
  private readonly notify: (binding: Binding) => void;
  private readonly transport: Transport;
  private readonly jobs = new Map<string, Map<string, Job>>();
  private readonly polling = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  constructor(query: CustomToolQuery, notify: (binding: Binding) => void, transport: Transport = exchange, filename?: string) {
    this.filename = filename;
    if (filename && existsSync(filename)) {
      const entries: unknown = JSON.parse(readFileSync(filename, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('Invalid tool receipt journal.');
      for (const [key, receipt] of entries) if (receipt.deadline > Date.now()) this.receipts.set(key, receipt);
    }
    this.query = query; this.notify = notify; this.transport = transport; }
  private saveReceipts() {
    if (!this.filename) return;
    for (const [key, receipt] of this.receipts) if (receipt.deadline <= Date.now()) this.receipts.delete(key);
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.filename}.tmp`, JSON.stringify([...this.receipts]), { mode: 0o600 });
    renameSync(`${this.filename}.tmp`, this.filename);
  }
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
    const results = [...jobs.values()].filter(j => j.result !== undefined).slice(0, 1).map(j => ({ id: j.request.id, result: j.result }));
    const raw = await this.transport(connection, { protocol: 1, results }, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]));
    const body = raw as { protocol?: number; requests?: CustomToolRequest[] };
    if (body?.protocol !== 1 || !Array.isArray(body.requests) || body.requests.length > 4) throw new Error('Invalid CustomTool exchange.');
    if (!valid() || this.lifetime.signal.aborted) { for (const job of jobs.values()) job.controller.abort(); this.jobs.delete(scope); return; }
    for (const [id, job] of jobs) if (!body.requests.some(r => r.id === id)) { job.controller.abort(); jobs.delete(id); }
    for (const request of body.requests) {
      if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.id)
        || !Number.isSafeInteger(request.deadline) || request.deadline <= Date.now() || request.deadline > Date.now() + 65_000) throw new Error('Invalid CustomTool request.');
      if (typeof request.tool !== 'string' || !/^homie_[a-z][a-z0-9_]{0,47}$/.test(request.tool) || JSON.stringify(request.args).length > 65536) throw new Error('Invalid custom tool request.');
      const args = record(request.args);
      const prior = jobs.get(request.id);
      if (prior) { if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('Conflicting CustomTool request.'); continue; }
      if (this.running.size >= 4 || this.jobs.size >= 64 && !this.jobs.has(scope)) continue;
      const job: Job = { request, controller: new AbortController() }; jobs.set(request.id, job); this.jobs.set(scope, jobs);
      const receiptKey = `${scope}/${request.id}`;
      const receipt = this.receipts.get(receiptKey);
      if (receipt) { job.result = receipt.result ?? customToolFailure('A previous execution was interrupted. External completion is unknown; do not retry automatically.'); this.notify(binding); continue; }
      this.receipts.set(receiptKey, { deadline: request.deadline }); this.saveReceipts();
      const signal = AbortSignal.any([job.controller.signal, this.lifetime.signal, AbortSignal.timeout(Math.max(1, request.deadline - Date.now()))]);
      const run = this.query(binding, request.tool, args, signal).then(result => {
        job.result = valid() && !signal.aborted ? result : customToolFailure('CustomTool assignment changed or request expired.');
      }, () => { job.result = customToolFailure('Custom tool failed. External completion may be unknown; do not automatically retry.'); }).finally(() => {
        this.receipts.set(receiptKey, { deadline: request.deadline, result: job.result });
        try { this.saveReceipts(); } catch { /* The durable started receipt still prevents automatic replay. */ }
        this.running.delete(run); if (!this.lifetime.signal.aborted) this.notify(binding);
      });
      this.running.add(run);
    }
    if (!jobs.size) this.jobs.delete(scope);
  }
  async dispose() { this.lifetime.abort(); for (const jobs of this.jobs.values()) for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...this.polling.values(), ...this.running]); this.jobs.clear(); }
}
