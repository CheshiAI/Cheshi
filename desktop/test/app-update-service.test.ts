import { describe, expect, it } from 'bun:test';
import { APP_UPDATE_INTERVAL_MS, createAppUpdateService } from '../lib/app-update-service.mts';
import type { AppRelease, AppUpdateProgress } from '../shared/app-update.ts';

const release: AppRelease = {
  version: '0.0.2-alpha', tag: 'v0.0.2-alpha', url: 'https://github.com/CheshiAI/Cheshi/releases/tag/v0.0.2-alpha', notes: 'Fix startup.',
  asset: { name: 'Cheshi.zip', url: 'https://github.com/CheshiAI/Cheshi/releases/download/v0.0.2-alpha/Cheshi.zip', size: 100, sha256: 'a'.repeat(64) },
};
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
async function expectFailure(operation: Promise<unknown>, message: string) {
  let rejection: unknown;
  try { await operation; } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}
function fixture(changes: Partial<Parameters<typeof createAppUpdateService>[0]> = {}) {
  let time = 0;
  let checks = 0;
  const service = createAppUpdateService({
    currentVersion: '0.0.1-alpha', check: async () => { checks++; return release; },
    install: async () => {}, openExternal: async () => {}, unavailableReason: null,
    now: () => time, ...changes,
  });
  return { service, checks: () => checks, advance: (milliseconds: number) => { time += milliseconds; } };
}

describe('app update scheduling and installation', () => {
  it('checks once at startup and checks resume only when an hour has elapsed', async () => {
    const value = fixture();
    try {
      value.service.start();
      value.service.start();
      await value.service.resume();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(value.checks()).toBe(1);
      value.advance(APP_UPDATE_INTERVAL_MS - 1);
      await value.service.resume();
      expect(value.checks()).toBe(1);
      value.advance(1);
      await value.service.resume();
      expect(value.checks()).toBe(2);
      expect(value.service.snapshot().release?.tag).toBe(release.tag);
    } finally { value.service.dispose(); }
  });

  it('prevents overlapping slow checks and preserves a discovered update after network failure', async () => {
    const gate = createDeferred<AppRelease | null>();
    let calls = 0;
    const failures: unknown[] = [];
    const value = fixture({ check: async () => { if (++calls === 1) return gate.promise; throw new Error('offline'); }, onCheckError: error => failures.push(error) });
    try {
      const first = value.service.resume();
      value.advance(APP_UPDATE_INTERVAL_MS);
      const second = value.service.resume();
      gate.resolve(release);
      await Promise.all([first, second]);
      expect(calls).toBe(1);
      value.advance(APP_UPDATE_INTERVAL_MS);
      await value.service.resume();
      expect(calls).toBe(2);
      expect(failures).toHaveLength(1);
      expect(value.service.snapshot().release).toEqual(release);
    } finally { value.service.dispose(); }
  });

  it('checks periodically while the app stays running', async () => {
    const secondCheck = createDeferred<void>();
    let calls = 0;
    const value = fixture({ intervalMs: 10, now: Date.now, check: async () => { if (++calls === 2) secondCheck.resolve(); return null; } });
    try {
      value.service.start();
      await secondCheck.promise;
      expect(calls).toBe(2);
    } finally { value.service.dispose(); }
  });

  it('runs one install, exposes failure, and allows a later retry', async () => {
    const gate = createDeferred<void>();
    let installs = 0;
    const value = fixture({ install: async (_release, report) => { installs++; report({ phase: 'installing' }); if (installs === 1) await gate.promise; } });
    try {
      await value.service.resume();
      const first = value.service.install();
      const failed = expectFailure(first, 'download failed');
      await value.service.install();
      value.advance(APP_UPDATE_INTERVAL_MS);
      await value.service.resume();
      expect(installs).toBe(1);
      expect(value.checks()).toBe(1);
      expect(value.service.snapshot().phase).toBe('installing');
      gate.reject(new Error('download failed'));
      await failed;
      expect(value.service.snapshot().phase).toBe('idle');
      expect(value.service.snapshot().error).toBe('download failed');
      await value.service.resume();
      expect(value.service.snapshot().error).toBe('download failed');
      await value.service.install();
      expect(installs).toBe(2);
      expect(value.service.snapshot().error).toBeNull();
    } finally { value.service.dispose(); }
  });

  it('publishes real download progress and clears it for verification, installation and restart', async () => {
    const gate = createDeferred<void>();
    let report!: (progress: AppUpdateProgress) => void;
    const value = fixture({ install: async (_release, listener) => { report = listener; await gate.promise; } });
    try {
      await value.service.resume();
      const pending = value.service.install();
      expect(value.service.snapshot().phase).toBe('preparing');
      report({ phase: 'downloading', receivedBytes: 25, totalBytes: 100 });
      expect(value.service.snapshot().downloadProgress).toEqual({ receivedBytes: 25, totalBytes: 100 });
      for (const receivedBytes of [24, -1, 101, NaN, 25.5]) report({ phase: 'downloading', receivedBytes, totalBytes: 100 });
      expect(value.service.snapshot().downloadProgress?.receivedBytes).toBe(25);
      report({ phase: 'downloading', receivedBytes: 100, totalBytes: 100 });
      for (const phase of ['verifying', 'installing', 'restarting'] as const) {
        report({ phase });
        expect(value.service.snapshot().phase).toBe(phase);
        expect(value.service.snapshot().downloadProgress).toBeUndefined();
      }
      gate.resolve();
      await pending;
      report({ phase: 'downloading', receivedBytes: 0, totalBytes: 100 });
      expect(value.service.snapshot().phase).toBe('restarting');
    } finally { gate.resolve(); value.service.dispose(); }
  });

  it('resets progress on failure and retry and ignores callbacks from a failed attempt', async () => {
    const gates = [createDeferred<void>(), createDeferred<void>()];
    const reports: ((progress: AppUpdateProgress) => void)[] = [];
    const value = fixture({ install: async (_release, report) => {
      const index = reports.push(report) - 1;
      await gates[index]!.promise;
    } });
    try {
      await value.service.resume();
      const first = expectFailure(value.service.install(), 'offline');
      reports[0]!({ phase: 'downloading', receivedBytes: 50, totalBytes: 100 });
      gates[0]!.reject(new Error('offline'));
      await first;
      expect(value.service.snapshot().downloadProgress).toBeUndefined();
      const retry = value.service.install();
      reports[0]!({ phase: 'restarting' });
      expect(value.service.snapshot().phase).toBe('preparing');
      reports[1]!({ phase: 'downloading', receivedBytes: 0, totalBytes: 100 });
      expect(value.service.snapshot().downloadProgress?.receivedBytes).toBe(0);
      gates[1]!.resolve();
      await retry;
    } finally { for (const gate of gates) gate.resolve(); value.service.dispose(); }
  });

  it('retains release notes but refuses installation without a matching asset or runtime support', async () => {
    const value = fixture({ check: async () => ({ ...release, asset: null }) });
    try {
      await value.service.resume();
      expect(value.service.snapshot().release?.notes).toBe(release.notes);
      await expectFailure(value.service.install(), '');
      value.service.setUnavailableReason('development build');
      await expectFailure(value.service.install(), 'development build');
    } finally { value.service.dispose(); }
  });

  it('returns detached snapshots and ignores late results after disposal', async () => {
    const gate = createDeferred<AppRelease | null>();
    let signal: AbortSignal | undefined;
    let notifications = 0;
    const value = fixture({ check: async incoming => { signal = incoming; return gate.promise; } });
    value.service.subscribe(() => { notifications++; });
    const pending = value.service.resume();
    await Promise.resolve();
    value.service.dispose();
    gate.resolve(release);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(value.service.snapshot().release).toBeNull();
    expect(notifications).toBe(0);
    const snapshot = value.service.snapshot();
    snapshot.error = 'mutated';
    expect(value.service.snapshot().error).toBeNull();
  });
});
