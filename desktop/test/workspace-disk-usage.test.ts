import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { link as createHardLink, mkdir, mkdtemp, rm, stat, statfs, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { workspaceDiskUsage } from '../shared/workspace-disk-usage';
import { createWorkspaceDiskUsageService, measureWorkspaceDiskUsage, parseWorkspaceAllocatedBytes } from '../lib/workspace-disk-usage.mts';
import { registerWorkspaceFileIpcHandlers } from '../lib/workspace-file-ipc.mts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'cheshi-disk-usage-'));
  directories.push(root);
  return root;
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function failure(operation: () => unknown | Promise<unknown>, pattern: RegExp) {
  let reason: unknown;
  try { await operation(); } catch (error) { reason = error; }
  expect(reason).toBeInstanceOf(Error);
  expect((reason as Error).message).toMatch(pattern);
}

describe('workspace disk usage boundaries', () => {
  test('reads allocated KiB without interpreting directory names as numbers', () => {
    expect(parseWorkspaceAllocatedBytes('123\t/workspace/with spaces\n')).toBe(125_952);
    expect(parseWorkspaceAllocatedBytes('0\t/workspace/with\nnewlines\n')).toBe(0);
    for (const value of ['', '-1\t/workspace', '1.5\t/workspace', 'failed\n1\t/workspace', '99999999999999999999\t/workspace']) {
      expect(() => parseWorkspaceAllocatedBytes(value)).toThrow();
    }
  });

  test('rejects invalid measurements at the shared bridge boundary', () => {
    const valid = { workspaceBytes: 1024, totalBytes: 100_000, measuredAt: 123 };
    expect(workspaceDiskUsage(valid)).toEqual(valid);
    for (const field of ['workspaceBytes', 'totalBytes', 'measuredAt']) {
      for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        expect(() => workspaceDiskUsage({ ...valid, [field]: value })).toThrow('Invalid workspace disk usage response');
      }
    }
    expect(() => workspaceDiskUsage({ ...valid, totalBytes: 0 })).toThrow();
    expect(workspaceDiskUsage({ ...valid, workspaceBytes: 0 })).toMatchObject({ workspaceBytes: 0 });
  });

  test('rejects unsupported platforms and invalid workspace roots before starting a scan', async () => {
    await failure(() => measureWorkspaceDiskUsage('/unvisited', 'win32'), /macOS and Linux/);
    let measured = false;
    const get = createWorkspaceDiskUsageService({ measure: async () => {
      measured = true; return { workspaceBytes: 1, totalBytes: 10 };
    } });
    for (const root of ['relative/path', '', '/nul\0byte']) await failure(() => get(root), /absolute directory/);
    expect(measured).toBe(false);
    if (!supported) return;
    const root = await directory();
    const file = path.join(root, 'file.txt');
    await writeFile(file, 'text');
    await failure(() => measureWorkspaceDiskUsage(file), /requires a directory/);
    await failure(() => measureWorkspaceDiskUsage(path.join(root, 'missing')), /ENOENT/);
  });
});

describe('workspace disk usage caching', () => {
  test('shares concurrent scans and caches the completed measurement for five minutes', async () => {
    const pending = createDeferred<{ workspaceBytes: number; totalBytes: number }>();
    let now = 1_000;
    let calls = 0;
    const get = createWorkspaceDiskUsageService({ now: () => now, measure: async () => {
      calls += 1; return pending.promise;
    } });
    const first = get('/workspace/project');
    const second = get('/workspace/project/./');
    expect(second).toBe(first);
    now = 2_000;
    pending.resolve({ workspaceBytes: 12_345, totalBytes: 999_999 });
    expect(await first).toEqual({ workspaceBytes: 12_345, totalBytes: 999_999, measuredAt: 2_000 });
    now += 299_999;
    const cached = await get('/workspace/project');
    cached.workspaceBytes = 0;
    expect((await get('/workspace/project')).workspaceBytes).toBe(12_345);
    expect(calls).toBe(1);
    now += 1;
    expect((await get('/workspace/project')).measuredAt).toBe(now);
    expect(calls).toBe(2);
  });

  test('coalesces failures, retries after fifteen seconds, and never returns partial success', async () => {
    const pending = createDeferred<{ workspaceBytes: number; totalBytes: number }>();
    let now = 1_000;
    let calls = 0;
    const get = createWorkspaceDiskUsageService({ now: () => now, measure: async () => {
      calls += 1;
      return calls === 1 ? pending.promise : { workspaceBytes: 5, totalBytes: 100 };
    } });
    const first = get('/workspace');
    const second = get('/workspace');
    expect(first).toBe(second);
    const rejected = failure(() => first, /permission denied/);
    pending.reject(new Error('permission denied'));
    await rejected;
    now += 14_999;
    await failure(() => get('/workspace'), /permission denied/);
    expect(calls).toBe(1);
    now += 1;
    expect(await get('/workspace')).toEqual({ workspaceBytes: 5, totalBytes: 100, measuredAt: now });
    expect(calls).toBe(2);
  });

  test('separates roots and bounds cached entries while preserving validation failures', async () => {
    let calls = 0;
    const get = createWorkspaceDiskUsageService({ measure: async root => {
      calls += 1;
      return { workspaceBytes: path.basename(root) === 'invalid' ? NaN : 1, totalBytes: 100 };
    } });
    await failure(() => get('/invalid'), /Invalid workspace disk usage/);
    await failure(() => get('/invalid'), /Invalid workspace disk usage/);
    expect(calls).toBe(1);
    for (let index = 0; index < 65; index += 1) await get(`/workspace-${index}`);
    expect(calls).toBe(66);
    await get('/workspace-0');
    expect(calls).toBe(67);
  });
});

const supported = process.platform === 'darwin' || process.platform === 'linux';
describe.skipIf(!supported)('workspace disk usage filesystem integration', () => {
  test('includes hidden and dependency directories, counts hard links once, and does not follow nested symlinks', async () => {
    const root = await directory();
    const workspace = path.join(root, 'workspace with spaces');
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    await mkdir(path.join(workspace, 'node_modules'));
    const tracked = path.join(workspace, '.git', 'payload');
    const dependency = path.join(workspace, 'node_modules', 'payload');
    const outside = path.join(root, 'outside');
    await writeFile(tracked, randomBytes(1024 * 1024));
    await writeFile(dependency, randomBytes(128 * 1024));
    await writeFile(outside, randomBytes(2 * 1024 * 1024));
    const before = await measureWorkspaceDiskUsage(workspace);
    const trackedBlocks = (await stat(tracked)).blocks * 512;
    const dependencyBlocks = (await stat(dependency)).blocks * 512;
    expect(before.workspaceBytes).toBeGreaterThanOrEqual(trackedBlocks + dependencyBlocks);
    await createHardLink(tracked, path.join(workspace, 'node_modules', 'hardlink'));
    await createSymbolicLink(outside, path.join(workspace, 'outside-link'));
    const after = await measureWorkspaceDiskUsage(workspace);
    expect(after.workspaceBytes - before.workspaceBytes).toBeLessThan(trackedBlocks);
    const volume = await statfs(workspace, { bigint: true });
    expect(after.totalBytes).toBe(Number(volume.bsize * volume.blocks));
  });

  test('IPC scans only its configured workspace, ignoring renderer supplied paths', async () => {
    const root = await directory();
    await writeFile(path.join(root, 'file'), randomBytes(16 * 1024));
    type Handler = Parameters<IpcMain['handle']>[1];
    const handlers = new Map<string, Handler>();
    registerWorkspaceFileIpcHandlers({ workspaceRoot: root,
      ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      clipboard: { writeText() {} }, shell: { async trashItem() {} } });
    const handler = handlers.get('cheshi:get-workspace-disk-usage');
    expect(handler).toBeDefined();
    const result = workspaceDiskUsage(await handler!({} as IpcMainInvokeEvent, '/untrusted/nonexistent/path'));
    expect(result.workspaceBytes).toBeGreaterThanOrEqual(16 * 1024);
    expect(result.workspaceBytes).toBeLessThan(1024 * 1024);
    expect(result.measuredAt).toBeGreaterThan(0);
  });
});
