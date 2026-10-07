import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

export interface FlashConnection {
  socketPath: string;
  token: string;
  timeoutMs?: number;
}

export class FlashError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Trusted host boundary. Credentials never enter model-visible tool arguments. */
export function callFlash<T = unknown>(
  connection: FlashConnection, method: string, params: Record<string, unknown>, signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new FlashError('canceled', 'Request canceled'));
  const id = randomUUID();
  const request = JSON.stringify({ version: 1, id, token: connection.token, method, params }) + '\n';
  if (Buffer.byteLength(request) > 262144) return Promise.reject(new FlashError('invalid_request', 'Request too large'));
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection({ path: connection.socketPath });
    const parts: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (error: Error | null, value?: T) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new FlashError('canceled', 'Request canceled'));
    const timer = setTimeout(() => finish(new FlashError('timeout', 'Service deadline exceeded')), connection.timeoutMs ?? 35000);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1048576) { finish(new FlashError('unavailable', 'Response too large')); return; }
      parts.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const response: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error();
        const value = response as Record<string, unknown>;
        if (value.version !== 1 || value.id !== id) throw new Error();
        if (value.error && typeof value.error === 'object') {
          const error = value.error as Record<string, unknown>;
          if (typeof error.code !== 'string' || typeof error.message !== 'string') throw new Error();
          finish(new FlashError(error.code, error.message));
        } else if (Object.hasOwn(value, 'result')) finish(null, value.result as T);
        else throw new Error();
      } catch { finish(new FlashError('unavailable', 'Invalid service response')); }
    });
    socket.once('error', () => finish(new FlashError('unavailable', 'Could not connect to Flash')));
    socket.once('close', () => finish(new FlashError('unavailable', 'Service connection closed')));
  });
}
