import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostPythonRuntime } from '../lib/agent-management/host-python-runtime.mts';
import { hostPythonDistribution, type PythonDistribution } from '../lib/agent-management/host-python-catalog.mts';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol';

async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
async function fixture(probeVersion = '3.14.8', root = 'python') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'managed python test-')));
  const source = join(directory, 'source'), binary = join(source, root, 'bin', 'python3.14');
  await mkdir(join(source, root, 'bin'), { recursive: true });
  // A fake interpreter at the executable boundary; archive/download handling is real.
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '{"version":"${probeVersion}"}'\n`);
  await chmod(binary, 0o700);
  const archive = join(directory, 'fixture.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', source, root]);
  const bytes = await readFile(archive), storage = join(directory, 'runtimes');
  const distribution: PythonDistribution = { id: 'fixture-3.14.8', version: '3.14.8', executable: 'python/bin/python3.14',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/fixture/python.tar.gz',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { directory, storage, bytes, distribution, close: () => rm(directory, { recursive: true, force: true }) };
}

test('catalog pins Mac architecture, exact version, archive size and hash', () => {
  for (const arch of ['arm64', 'x64']) {
    const entry = hostPythonDistribution('3.14.8', 'darwin', arch);
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/); expect(entry.bytes).toBeGreaterThan(20_000_000);
    expect(entry.url).toContain('/20261013/'); expect(entry.url).not.toContain('/latest/');
  }
  expect(() => hostPythonDistribution('3.1.0')).toThrow('catalog');
  expect(() => hostPythonDistribution('3.14.8', 'win32', 'x64')).toThrow('not available');
});

test('concurrent preparation shares a verified installation, including offline reuse after restart', async () => {
  const f = await fixture(); let downloads = 0;
  const options = { distribution: () => f.distribution, download: async () => { downloads++; return new Response(f.bytes); } };
  const runtime = new HostPythonRuntime(f.storage, options), second = new HostPythonRuntime(f.storage, options);
  try {
    const [a, b] = await Promise.all([runtime.prepare(), second.prepare()]);
    expect(a).toEqual(b); expect(downloads).toBe(1);
    expect(runtime.matches(a.executable, a.id)).toBe(true);
    expect(runtime.matches('/usr/bin/python3', a.id)).toBe(false);
    expect(await readdir(f.storage)).toEqual([f.distribution.id]);
    runtime.dispose(); second.dispose();
    const offline = new HostPythonRuntime(f.storage, { distribution: options.distribution, download: async () => { throw new Error('offline'); } });
    try { expect(await offline.prepare()).toEqual(a); } finally { offline.dispose(); }
  } finally { runtime.dispose(); second.dispose(); await f.close(); }
});

test('wrong checksum, truncated or oversized downloads never publish or execute Python', async () => {
  for (const failure of ['checksum', 'truncated', 'oversized']) {
    const f = await fixture();
    const bytes = failure === 'truncated' ? f.bytes.subarray(1) : failure === 'oversized' ? Buffer.concat([f.bytes, Buffer.from('x')]) : Buffer.alloc(f.bytes.length);
    const runtime = new HostPythonRuntime(f.storage, { distribution: () => f.distribution, download: async () => new Response(bytes) });
    try {
      await fails(runtime.prepare(), failure === 'oversized' ? 'size' : 'checksum');
      expect(await readdir(f.storage)).toEqual([]);
    } finally { runtime.dispose(); await f.close(); }
  }
});

test('network failures and redirected non-publisher URLs do not fall back to system Python', async () => {
  const f = await fixture();
  try {
    for (const response of [new Response('offline', { status: 503 }), new Response(null, { status: 302, headers: { location: 'http://example.com/python' } })]) {
      const runtime = new HostPythonRuntime(f.storage, { distribution: () => f.distribution, download: async () => response });
      try { await fails(runtime.prepare(), response.status === 503 ? 'HTTP 503' : 'destination'); expect(await readdir(f.storage)).toEqual([]); }
      finally { runtime.dispose(); }
    }
  } finally { await f.close(); }
});

test('invalid archive roots and wrong interpreter versions are rejected before publication', async () => {
  for (const [version, root, message] of [['3.0.0', 'python', 'version'], ['3.14.8', 'outside', 'paths']]) {
    const f = await fixture(version, root);
    const runtime = new HostPythonRuntime(f.storage, { distribution: () => f.distribution, download: async () => new Response(f.bytes) });
    try { await fails(runtime.prepare(), message!); expect(await readdir(f.storage)).toEqual([]); }
    finally { runtime.dispose(); await f.close(); }
  }
});

test('changed cached executables are rejected without overwriting the installation', async () => {
  const f = await fixture(); let downloads = 0;
  const runtime = new HostPythonRuntime(f.storage, { distribution: () => f.distribution, download: async () => { downloads++; return new Response(f.bytes); } });
  try {
    const installed = await runtime.prepare();
    await writeFile(installed.executable, '#!/bin/sh\nexit 1\n');
    await fails(runtime.prepare(), 'changed'); expect(downloads).toBe(1);
    expect(await readFile(installed.executable, 'utf8')).toContain('exit 1');
  } finally { runtime.dispose(); await f.close(); }
});

test('shutdown aborts preparation and removes only its temporary installation', async () => {
  const f = await fixture(), started = createDeferred<void>();
  const runtime = new HostPythonRuntime(f.storage, { distribution: () => f.distribution, download: async (_url, options) => {
    started.resolve();
    return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  try {
    const pending = fails(runtime.prepare(), 'aborted');
    await started.promise; runtime.dispose(); await pending;
    expect(await readdir(f.storage)).toEqual([]);
  } finally { runtime.dispose(); await f.close(); }
});
