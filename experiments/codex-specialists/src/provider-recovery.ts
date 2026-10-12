import { setTimeout as delay } from 'node:timers/promises';

export interface ProviderFailure {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
}
const aliases: Record<string, string> = { serverOverloaded: 'server_overloaded', rateLimitExceeded: 'rate_limit_exceeded' };
const transient = new Set(['server_overloaded', 'server_is_overloaded', 'rate_limit_exceeded', 'slow_down', 'service_unavailable']);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Keep operational metadata, never provider input/body fields. Unknown failures are not retried. */
export function providerFailure(value: unknown): ProviderFailure {
  const error = object(value), data = object(error.data), info = error.codexErrorInfo ?? data.codexErrorInfo;
  const raw = typeof error.code === 'string' ? error.code : typeof info === 'string' ? info : Object.keys(object(info))[0] ?? (typeof data.code === 'string' ? data.code : undefined);
  const code = raw && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(raw) ? raw
    : error.message === 'Selected model is at capacity. Please try a different model.' ? 'server_overloaded' : 'unknown';
  const wait = error.retryAfterMs ?? data.retryAfterMs;
  return { code, retryable: transient.has(aliases[code] ?? code),
    ...(typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? { retryAfterMs: Math.ceil(wait) } : {}) };
}

export class ProviderRequestError extends Error {
  readonly failure: ProviderFailure;
  constructor(value: unknown, fallback = 'Model request failed.') {
    super(typeof object(value).message === 'string' ? String(object(value).message) : fallback);
    this.failure = providerFailure(value);
  }
}

export function retryDelay(failure: ProviderFailure, attempts: number): number | null {
  if (!failure.retryable || attempts >= 2 || (failure.retryAfterMs ?? 0) > 30_000) return null;
  return Math.max(failure.retryAfterMs ?? 0, [1000, 3000][attempts]!);
}

export type RetryWait = (ms: number, signal: AbortSignal) => Promise<void>;
export const waitForRetry: RetryWait = async (ms, signal) => { await delay(ms, undefined, { signal }); };

/** Only for tool-free, read-only inference. Each successful stage is returned once. */
export async function retryInference<T>(run: () => Promise<T>, signal: AbortSignal, wait: RetryWait = waitForRetry): Promise<T> {
  for (let attempts = 0; ; attempts++) {
    signal.throwIfAborted();
    try { return await run(); }
    catch (error) {
      signal.throwIfAborted();
      const ms = error instanceof ProviderRequestError ? retryDelay(error.failure, attempts) : null;
      if (ms === null) throw error;
      await wait(ms, signal);
    }
  }
}

export interface ProviderCheckpoint {
  attempts: number;
  retryAt: number;
  threadId: string;
  turnId: string;
  pending: boolean;
}
export function parseProviderCheckpoint(value: unknown): ProviderCheckpoint {
  const v = object(value);
  if (!Number.isInteger(v.attempts) || Number(v.attempts) < 1 || Number(v.attempts) > 2
    || typeof v.retryAt !== 'number' || !Number.isFinite(v.retryAt) || v.retryAt < 0
    || typeof v.threadId !== 'string' || !v.threadId || v.threadId.length > 200 || typeof v.turnId !== 'string' || !v.turnId || v.turnId.length > 200
    || typeof v.pending !== 'boolean') throw new TypeError('Invalid provider checkpoint.');
  return { attempts: Number(v.attempts), retryAt: v.retryAt, threadId: v.threadId, turnId: v.turnId, pending: v.pending };
}

/** Unknown tool execution is treated as potentially mutating. */
export function readOnlyItem(value: unknown): boolean {
  const item = object(value);
  if (['agentMessage', 'userMessage', 'reasoning', 'plan', 'contextCompaction'].includes(String(item.type))) return true;
  return item.type === 'dynamicToolCall' && ['memory_search', 'memory_read'].includes(String(item.tool));
}

export function assertRetryCheckpoint(value: unknown, checkpoint: ProviderCheckpoint, workspace: string): void {
  const thread = object(object(value).thread), turns = thread.turns;
  const last = Array.isArray(turns) ? object(turns.at(-1)) : {};
  if (thread.id !== checkpoint.threadId || thread.cwd !== workspace || thread.parentThreadId != null || thread.ephemeral === true
    || !Array.isArray(turns) || turns.filter(t => object(t).id === checkpoint.turnId).length !== 1 || last.id !== checkpoint.turnId
    || last.status !== 'failed' || !Array.isArray(last.items) || !last.items.every(readOnlyItem)) {
    throw new Error('Cannot safely resume: inspect the saved execution before continuing.');
  }
}
