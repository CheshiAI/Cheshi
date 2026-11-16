import { randomUUID } from 'node:crypto';
import { createDeferred, record } from './protocol.ts';
import { memoryArguments } from './flash-tools.ts';
import { flashId } from './flash-history.ts';

export const FLASH_TIMEOUT_MS = 420_000;
export interface FlashRequest { id: string; tool: string; args: Record<string, unknown>; threadId: string; turnId: string; deadline: number }
export const flashFailure = (text: string) => ({ isError: true, error: text });
export class WorkerFlashQueue {
  private readonly jobs = new Map<string, { request: FlashRequest; waiter: ReturnType<typeof createDeferred<unknown>> }>();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  get pending() { return this.jobs.size > 0; }
  async call(tool: string, value: unknown, threadId: string, turnId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const args = memoryArguments(tool, value);
    if (this.jobs.size >= 4) throw new Error('Too many Flash requests.');
    const request = { id: randomUUID(), tool, args, threadId: flashId(threadId), turnId: flashId(turnId), deadline: Date.now() + FLASH_TIMEOUT_MS };
    const waiter = createDeferred<unknown>();
    this.jobs.set(request.id, { request, waiter });
    const cancel = () => waiter.resolve(flashFailure('Flash request canceled or timed out. This does not mean no history exists.'));
    const timer = setTimeout(cancel, FLASH_TIMEOUT_MS);
    signal.addEventListener('abort', cancel, { once: true }); this.changed();
    try { return await waiter.promise; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); this.jobs.delete(request.id); this.changed(); }
  }
  exchange(value: unknown) {
    const input = record(value);
    if (input.protocol !== 1 || !Array.isArray(input.results) || input.results.length > 4) throw new Error('Invalid Flash exchange.');
    for (const raw of input.results) { const result = record(raw); this.jobs.get(flashId(result.id))?.waiter.resolve(result.result); }
    return { protocol: 1, requests: [...this.jobs.values()].map(j => j.request) };
  }
}
