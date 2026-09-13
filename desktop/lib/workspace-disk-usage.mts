import { execFile } from 'node:child_process';
import { realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { workspaceDiskUsage, type WorkspaceDiskUsage } from '../shared/workspace-disk-usage.ts';

const executeFile = promisify(execFile);
const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 15_000;
const MAX_CACHED_ROOTS = 64;
const MEASUREMENT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

type Measurement = Pick<WorkspaceDiskUsage, 'workspaceBytes' | 'totalBytes'>;
type CachedUsage = { expiresAt: number; value: WorkspaceDiskUsage } | { expiresAt: number; error: Error };

interface DiskUsageOptions {
  measure?: (root: string) => Promise<Measurement>;
  now?: () => number;
}

function workspaceRoot(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new TypeError('Workspace disk usage requires an absolute directory path.');
  }
  return path.resolve(value);
}

function safeByteCount(value: bigint, label: string, positive = false): number {
  if (value < (positive ? 1n : 0n) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the supported byte range.`);
  }
  return Number(value);
}

export function parseWorkspaceAllocatedBytes(stdout: string): number {
  // Only parse du's first tab-delimited field; a valid folder name can contain newlines.
  const match = /^(\d+)\t/.exec(stdout);
  if (!match) throw new Error('The workspace disk usage measurement was invalid.');
  return safeByteCount(BigInt(match[1]!) * 1024n, 'Workspace disk usage');
}

/**
 * du counts allocated blocks, hidden files and dependencies, counting hard links once.
 * It does not follow nested symlinks or cross into a different mounted filesystem.
 * APFS clones, compression and shared blocks prevent interpreting this as exclusive
 * physical storage or the exact space that deleting this directory would release.
 */
export async function measureWorkspaceDiskUsage(root: string, platform: NodeJS.Platform = process.platform): Promise<Measurement> {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error('Workspace disk usage is currently supported on macOS and Linux.');
  }
  const canonicalRoot = await realpath(workspaceRoot(root));
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error('Workspace disk usage requires a directory.');
  const [usage, volume] = await Promise.all([
    executeFile('/usr/bin/nice', ['-n', '10', '/usr/bin/du', '-sk', '-x', canonicalRoot], {
      encoding: 'utf8', timeout: MEASUREMENT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, LC_ALL: 'C' },
    }),
    statfs(canonicalRoot, { bigint: true }),
  ]);
  return {
    workspaceBytes: parseWorkspaceAllocatedBytes(usage.stdout),
    totalBytes: safeByteCount(volume.bsize * volume.blocks, 'Volume capacity', true),
  };
}

/** Each root shares one in-flight scan; errors expire quickly so transient failures can recover. */
export function createWorkspaceDiskUsageService({ measure = measureWorkspaceDiskUsage, now = Date.now }: DiskUsageOptions = {}) {
  const cache = new Map<string, CachedUsage>();
  const flights = new Map<string, Promise<WorkspaceDiskUsage>>();
  const remember = (root: string, entry: CachedUsage) => {
    cache.delete(root);
    cache.set(root, entry);
    if (cache.size > MAX_CACHED_ROOTS) cache.delete(cache.keys().next().value!);
  };
  return (root: string): Promise<WorkspaceDiskUsage> => {
    const key = workspaceRoot(root);
    const active = flights.get(key);
    if (active) return active;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return 'value' in cached ? Promise.resolve({ ...cached.value }) : Promise.reject(cached.error);
    }
    const flight = Promise.resolve().then(() => measure(key)).then(measured => {
      const value = workspaceDiskUsage({ ...measured, measuredAt: now() });
      remember(key, { value: { ...value }, expiresAt: now() + CACHE_MS });
      return value;
    }).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error('The workspace disk usage could not be measured.');
      remember(key, { error, expiresAt: now() + FAILURE_CACHE_MS });
      throw error;
    }).finally(() => { flights.delete(key); });
    flights.set(key, flight);
    return flight;
  };
}

export const getWorkspaceDiskUsage = createWorkspaceDiskUsageService();
