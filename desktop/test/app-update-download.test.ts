import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { downloadAppUpdate, serveAppUpdate, writeUpdateChunk } from '../lib/app-update-download.mts';
import type { AppRelease, AppReleaseAsset } from '../shared/app-update';

const bytes = new TextEncoder().encode('verified ZIP bytes');
const asset: AppReleaseAsset = { name: 'Cheshi.zip', size: bytes.byteLength,
  url: 'https://github.com/CheshiAI/Cheshi/releases/download/v0.0.2-alpha/Cheshi.zip',
  sha256: createHash('sha256').update(bytes).digest('hex') };
function createFetch(handler: (input: string, init: RequestInit | undefined) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}
async function expectFailure(operation: Promise<unknown>, message: string) {
  let rejection: unknown;
  try { await operation; } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}

describe('verified update downloads', () => {
  test('follows only approved redirects and writes private verified bytes', async () => {
    const requested: string[] = [];
    const result = await downloadAppUpdate(asset, { fetch: createFetch(async (url, init) => {
      requested.push(url);
      expect(init?.redirect).toBe('manual');
      return requested.length === 1 ? new Response(null, { status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/package?signature=abc' } }) : new Response(bytes);
    }) });
    try {
      expect(new Uint8Array(await readFile(result.filename))).toEqual(bytes);
      expect((await stat(result.filename)).mode & 0o777).toBe(0o600);
      expect(requested).toHaveLength(2);
    } finally { await result.dispose(); }
    await expectFailure(stat(result.filename), 'ENOENT');
  });
  test('rejects malformed metadata before any download', async () => {
    let requests = 0;
    const fetcher = createFetch(async () => { requests++; return new Response(bytes); });
    for (const changes of [
      { url: 'https://github.com/other/repo/releases/download/tag/app.zip' },
      { url: 'https://github.com/CheshiAI/Cheshi/releases/download/tag/app.zip?query=1' },
      { url: 'https://user@github.com/CheshiAI/Cheshi/releases/download/tag/app.zip' },
      { size: 0 }, { size: 4 * 1024 ** 3 + 1 }, { sha256: 'invalid' },
    ]) await expectFailure(downloadAppUpdate({ ...asset, ...changes }, { fetch: fetcher }), 'cannot be verified');
    expect(requests).toBe(0);
  });
  test('rejects redirected network targets outside the release asset hosts', async () => {
    for (const destination of ['http://127.0.0.1/private', 'https://evil.example/app.zip', 'https://user:pass@github.com/secret']) {
      let requests = 0;
      await expectFailure(downloadAppUpdate(asset, { fetch: createFetch(async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: destination } });
      }) }), 'not allowed');
      expect(requests).toBe(1);
    }
  });
  test('rejects tampered, truncated, and oversized payloads', async () => {
    for (const payload of [new Uint8Array(bytes.length), bytes.slice(1), new Uint8Array(bytes.length + 1)]) {
      await expectFailure(downloadAppUpdate(asset, { fetch: createFetch(async () => new Response(payload)) }), 'update asset');
    }
  });
  test('rejects failed status, missing redirect, redirect loops and cancellation', async () => {
    await expectFailure(downloadAppUpdate(asset, { fetch: createFetch(async () => new Response(null, { status: 403 })) }), '403');
    await expectFailure(downloadAppUpdate(asset, { fetch: createFetch(async () => new Response(null, { status: 302 })) }), 'destination');
    await expectFailure(downloadAppUpdate(asset, { fetch: createFetch(async () => new Response(null, {
      status: 302, headers: { location: asset.url },
    })) }), 'redirect limit');
    await expectFailure(downloadAppUpdate(asset, { signal: AbortSignal.abort(new Error('cancelled')),
      fetch: createFetch(async () => new Response(bytes)) }), 'cancelled');
  });
  test('writes every byte after partial filesystem writes and rejects zero progress', async () => {
    const written: number[] = [];
    await writeUpdateChunk(bytes, async (buffer, offset, length) => {
      const size = Math.min(length, 3);
      written.push(...buffer.slice(offset, offset + size));
      return { bytesWritten: size };
    });
    expect(new Uint8Array(written)).toEqual(bytes);
    await expectFailure(writeUpdateChunk(bytes, async () => ({ bytesWritten: 0 })), 'written completely');
  });
  test('serves only the random loopback feed and verified ZIP paths', async () => {
    const downloaded = await downloadAppUpdate(asset, { fetch: createFetch(async () => new Response(bytes)) });
    const release: AppRelease = { version: '0.0.2-alpha', tag: 'v0.0.2-alpha', notes: 'Changes',
      url: 'https://github.com/CheshiAI/Cheshi/releases/tag/v0.0.2-alpha', asset };
    try {
      const feed = await serveAppUpdate(release, downloaded.filename);
      try {
        expect(new URL(feed.url).hostname).toBe('localhost');
        const response = await fetch(feed.url);
        const metadata = await response.json() as { url: string; name: string; notes: string };
        expect(metadata.name).toBe(release.version);
        expect(metadata.notes).toBe('Changes');
        expect(new Uint8Array(await (await fetch(metadata.url)).arrayBuffer())).toEqual(bytes);
        expect((await fetch(new URL('/feed', feed.url))).status).toBe(404);
        expect((await fetch(feed.url, { method: 'POST' })).status).toBe(404);
      } finally { await feed.dispose(); }
    } finally { await downloaded.dispose(); }
  });
});
