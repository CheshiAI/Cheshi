import { expect, test } from 'bun:test';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostNodeRuntime } from '../lib/agent-management/host-node-runtime.mts';

test.skipIf(process.platform !== 'darwin')('Node refuses corrupted publisher bytes and cleans incomplete downloads for retry', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-node-download-')));
  let calls = 0;
  const download = async (input: string, options: RequestInit) => {
    calls++;
    expect(String(input)).toStartWith('https://nodejs.org/dist/v24.22.0/');
    expect(options?.redirect).toBe('error');
    return new Response('corrupted archive');
  };
  try {
    const runtime = new HostNodeRuntime(root, download);
    for (let attempt = 0; attempt < 2; attempt++) {
      let failure: unknown;
      try { await runtime.prepare(AbortSignal.timeout(1000)); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('checksum');
      expect(await readdir(root)).toEqual([]);
    }
    expect(calls).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
