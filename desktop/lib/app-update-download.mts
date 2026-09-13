import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppRelease, AppReleaseAsset } from '../shared/app-update.ts';

const MAX_DOWNLOAD_BYTES = 4 * 1024 ** 3;
function assertAsset(asset: AppReleaseAsset): void {
  const url = new URL(asset.url);
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/CheshiAI/Cheshi/releases/download/')
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD_BYTES
    || !/^[a-f\d]{64}$/i.test(asset.sha256)) throw new Error('The update asset cannot be verified.');
}

async function fetchAsset(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<Response> {
  let current = new URL(url);
  for (let redirect = 0; redirect < 5; redirect++) {
    if (current.protocol !== 'https:' || current.username || current.password || current.port
      || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(current.hostname)) {
      throw new Error('The update download URL is not allowed.');
    }
    const response = await fetcher(current, { redirect: 'manual', signal, headers: { 'User-Agent': 'Cheshi' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('The update download redirect is missing its destination.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`The update download failed (${response.status}).`); }
    return response;
  }
  throw new Error('The update download exceeded the redirect limit.');
}

export async function writeUpdateChunk(value: Uint8Array,
  write: (buffer: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number }>): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const written = await write(value, offset, value.byteLength - offset);
    if (!Number.isInteger(written.bytesWritten) || written.bytesWritten <= 0 || written.bytesWritten > value.byteLength - offset) {
      throw new Error('The update asset could not be written completely.');
    }
    offset += written.bytesWritten;
  }
}

export async function downloadAppUpdate(asset: AppReleaseAsset, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  assertAsset(asset);
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-update-'));
  const filename = path.join(directory, 'update.zip');
  const signal = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(options.signal ? [options.signal] : [])]);
  try {
    const response = await fetchAsset(asset.url, signal, options.fetch ?? fetch);
    if (!response.body) throw new Error('The update asset has no response body.');
    const file = await open(filename, 'wx', 0o600);
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > asset.size) throw new Error('The update asset size does not match.');
        hash.update(value);
        await writeUpdateChunk(value, (buffer, offset, length) => file.write(buffer, offset, length));
      }
      if (size !== asset.size || hash.digest('hex') !== asset.sha256.toLowerCase()) {
        throw new Error('The update asset failed verification. Please try again.');
      }
      await file.sync();
    } finally { await reader.cancel().catch(() => {}); await file.close(); }
    return { filename, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** Squirrel receives only our already verified ZIP through a short-lived loopback feed. */
export async function serveAppUpdate(release: AppRelease, filename: string) {
  if (!release.asset) throw new Error('Missing update asset.');
  const token = randomUUID();
  let baseUrl = '';
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !baseUrl) { response.writeHead(404).end(); return; }
    if (request.url === `/${token}/feed`) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ url: `${baseUrl}/${token}/update.zip`, name: release.version,
        notes: release.notes, pub_date: new Date().toISOString() }));
    } else if (request.url === `/${token}/update.zip`) {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': release.asset!.size });
      const stream = createReadStream(filename);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not start update feed.'); }
  baseUrl = `http://localhost:${address.port}`;
  return {
    url: `${baseUrl}/${token}/feed`,
    dispose: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
