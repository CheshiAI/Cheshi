import { randomUUID } from 'node:crypto';
import { createDeferred, record } from './protocol.ts';
import { codegraphArguments } from './codegraph-tools.ts';

export interface CodeGraphRequest { id: string; tool: string; args: Record<string, unknown>; deadline: number }
export const codegraphFailure = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });
/** Read-only requests need no durable replay after a worker restart. */
export class WorkerCodeGraphQueue {
  private readonly jobs = new Map<string, { request: CodeGraphRequest; waiter: ReturnType<typeof createDeferred<unknown>> }>();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  get pending() { return this.jobs.size > 0; }
  async call(tool: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const args = codegraphArguments(tool, value);
    if (this.jobs.size >= 4) throw new Error('Too many active CodeGraph requests.');
    const request = { id: randomUUID(), tool, args, deadline: Date.now() + 60_000 }, waiter = createDeferred<unknown>();
    this.jobs.set(request.id, { request, waiter });
    const cancel = () => waiter.resolve(codegraphFailure('CodeGraph request canceled or timed out. Retry or read project files.'));
    const timer = setTimeout(cancel, 60_000);
    signal.addEventListener('abort', cancel, { once: true });
    this.changed();
    try { return await waiter.promise; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); this.jobs.delete(request.id); this.changed(); }
  }
  exchange(value: unknown) {
    const body = record(value);
    if (body.protocol !== 1 || !Array.isArray(body.results) || body.results.length > 4) throw new Error('Invalid CodeGraph exchange.');
    for (const raw of body.results) {
      const item = record(raw);
      if (typeof item.id !== 'string') throw new Error('Invalid CodeGraph result.');
      this.jobs.get(item.id)?.waiter.resolve(item.result);
    }
    return { protocol: 1, requests: [...this.jobs.values()].map(j => j.request) };
  }
}
