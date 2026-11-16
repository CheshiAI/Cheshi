import { setTimeout as delay } from 'node:timers/promises';
export class DiscordHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Discord request failed (${status}). Check bot permissions and connection settings.`); this.status = status; }
}
export function createDiscordRest(token: string, signal: AbortSignal, fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch) {
  let tail: Promise<unknown> = Promise.resolve();
  let availableAt = 0;
  async function request(method: string, route: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 5; attempt++) {
      signal.throwIfAborted();
      if (availableAt > Date.now()) await delay(availableAt - Date.now(), undefined, { signal });
      const response = await fetcher(`https://discord.com/api/v10${route}`, {
        method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error',
      });
      const reset = Number(response.headers.get('x-ratelimit-reset-after'));
      if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) availableAt = Date.now() + Math.max(0, reset * 1000);
      if (response.status === 429) {
        const limited = await response.json() as { retry_after?: unknown };
        const seconds = Number(limited.retry_after);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) throw new DiscordHttpError(429);
        availableAt = Date.now() + Math.ceil(seconds * 1000) + 100; continue;
      }
      if (!response.ok) throw new DiscordHttpError(response.status);
      return response.status === 204 ? null : response.json();
    }
    throw new DiscordHttpError(429);
  }
  return (method: string, route: string, body?: unknown): Promise<unknown> => {
    const work = tail.then(() => request(method, route, body)); tail = work.catch(() => {}); return work;
  };
}
export type DiscordRest = ReturnType<typeof createDiscordRest>;
