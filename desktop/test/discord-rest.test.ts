import { expect, test } from 'bun:test';
import { createDiscordRest } from '../lib/discord-rest.mts';

test('rate limits are retried in order and secrets are never included in HTTP errors', async () => {
  let calls = 0;
  const fakeFetch = (async (_url: unknown, options: RequestInit) => {
    expect(options.redirect).toBe('error');
    calls++;
    return calls === 1 ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 }) : new Response('{"id":"ok"}');
  });
  const request = createDiscordRest('private-test-token', new AbortController().signal, fakeFetch);
  expect(await request('GET', '/users/@me')).toEqual({ id: 'ok' }); expect(calls).toBe(2);
  const denied = createDiscordRest('private-test-token', new AbortController().signal,
    async () => new Response('private-test-token', { status: 401 }));
  let error: unknown;
  try { await denied('GET', '/users/@me'); } catch (cause) { error = cause; }
  expect(String(error)).toContain('401'); expect(String(error)).not.toContain('private-test-token');
});
