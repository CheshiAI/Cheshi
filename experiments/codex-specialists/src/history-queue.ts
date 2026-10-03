import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createDeferred, record, textValue } from './protocol.ts';

type Job = { id: string; taskId: string; threadId: string; turnId: string; tool: string; args: Record<string, unknown>;
  deadline: number; status: 'pending' | 'done'; result?: unknown };
export class WorkerHistoryQueue {
  private readonly filename: string;
  private jobs: Job[];
  private waiters = new Map<string, ReturnType<typeof createDeferred<unknown>>>();
  constructor(directory: string) {
    this.filename = join(directory, 'state', 'history-requests.json');
    const saved: unknown = existsSync(this.filename) ? JSON.parse(readFileSync(this.filename, 'utf8')) : [];
    if (!Array.isArray(saved) || saved.length > 256 || saved.some(v => !v || typeof v.id !== 'string'
      || !['pending', 'done'].includes(v.status))) throw new Error('Invalid history request journal.');
    this.jobs = saved as Job[];
    this.save(this.jobs.map(j => j.status === 'pending' ? { ...j, status: 'done', result: { status: 'error', error: 'Worker restarted during recall; outcome and usage are unknown.' } } : j));
  }
  private save(jobs: Job[]) {
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(jobs), { mode: 0o600, flush: true });
    renameSync(`${this.filename}.tmp`, this.filename); this.jobs = jobs;
  }
  async call(taskId: string, threadId: string, turnId: string, callId: string, tool: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!['history_search', 'history_read'].includes(tool)) throw new Error('Unknown history tool.');
    const args = record(value);
    if (JSON.stringify(args).length > 4000) throw new Error('History arguments are too large.');
    const id = createHash('sha256').update(JSON.stringify([taskId, threadId, turnId, callId])).digest('hex');
    let job = this.jobs.find(j => j.id === id);
    if (job && (job.tool !== tool || JSON.stringify(job.args) !== JSON.stringify(args))) throw new Error('Conflicting history request id.');
    if (job?.status === 'done') return job.result;
    if (!job) {
      if (this.jobs.filter(j => j.status === 'pending').length >= 4) throw new Error('Too many active history requests.');
      job = { id, taskId, threadId, turnId, tool, args, deadline: Date.now() + 120_000, status: 'pending' };
      const retained = [...this.jobs];
      if (retained.length >= 256) retained.splice(retained.findIndex(j => j.status === 'done'), 1);
      this.save([...retained, job]);
    }
    let waiter = this.waiters.get(id);
    if (!waiter) { waiter = createDeferred<unknown>(); this.waiters.set(id, waiter); }
    const finish = (error: string) => {
      try { this.finish(id, { status: 'error', error, usage: 'unknown' }); }
      catch { waiter!.reject(new Error('Could not persist recall cancellation.')); }
    };
    const abort = () => finish('History request canceled.');
    const timer = setTimeout(() => finish('History relay timed out; usage may be unknown.'), Math.max(1, job.deadline - Date.now()));
    signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); return await waiter.promise; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.waiters.delete(id); }
  }
  private finish(id: string, result: unknown) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || job.status !== 'pending') return;
    this.save(this.jobs.map(j => j.id === id ? { ...j, status: 'done', result } : j));
    this.waiters.get(id)?.resolve(result);
  }
  exchange(value: unknown) {
    const body = record(value);
    if (body.protocol !== 1 || !Array.isArray(body.results) || body.results.length > 4) throw new Error('Invalid history exchange.');
    for (const value of body.results) {
      const item = record(value), id = textValue(item.id, 'request id');
      this.finish(id, body.enabled === true ? item.result : { status: 'unavailable', error: 'History recall is disabled.' });
    }
    if (body.enabled !== true) for (const job of this.jobs.filter(j => j.status === 'pending')) this.finish(job.id, { status: 'unavailable', error: 'History recall is disabled.' });
    return { protocol: 1, requests: this.jobs.filter(j => j.status === 'pending'), acknowledged: this.jobs.filter(j => j.status === 'done').map(j => j.id) };
  }
}
