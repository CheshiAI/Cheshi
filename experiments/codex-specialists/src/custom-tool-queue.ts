import { randomUUID } from 'node:crypto';
import { createDeferred, record } from './protocol.ts';


export interface CustomToolRequest { id: string; tool: string; args: Record<string, unknown>; deadline: number }
export const customToolFailure = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });
/** Pending calls are canceled on restart; never automatically retry external side effects. */
export class WorkerCustomToolQueue {
  private readonly jobs = new Map<string, { request: CustomToolRequest; waiter: ReturnType<typeof createDeferred<unknown>> }>();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  get pending() { return this.jobs.size > 0; }
  async call(tool: string, value: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const args = record(value);
    if (this.jobs.size >= 4) throw new Error('Too many active CustomTool requests.');
    const request = { id: randomUUID(), tool, args, deadline: Date.now() + 60_000 }, waiter = createDeferred<unknown>();
    this.jobs.set(request.id, { request, waiter });
    const cancel = () => waiter.resolve(customToolFailure('CustomTool request canceled or timed out. Do not automatically retry a tool with external side effects.'));
    const timer = setTimeout(cancel, 60_000);
    signal.addEventListener('abort', cancel, { once: true });
    this.changed();
    try { return await waiter.promise; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); this.jobs.delete(request.id); this.changed(); }
  }
  exchange(value: unknown) {
    const body = record(value);
    if (body.protocol !== 1 || !Array.isArray(body.results) || body.results.length > 4) throw new Error('Invalid CustomTool exchange.');
    for (const raw of body.results) {
      const item = record(raw);
      if (typeof item.id !== 'string') throw new Error('Invalid CustomTool result.');
      this.jobs.get(item.id)?.waiter.resolve(item.result);
    }
    return { protocol: 1, requests: [...this.jobs.values()].map(j => j.request) };
  }
}
