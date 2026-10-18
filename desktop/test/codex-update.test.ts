import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexUpdateService } from '../lib/codex-update-service.mts';
import { createCodexInstallation, insideCodexCask } from '../lib/codex-update-installation.mts';
import { codexVersion, newerCodexVersion, parseCodexVersion, type CodexWorkerVersions, type CodexUpdateReporter, type CodexUpdateState } from '../shared/codex-update';
import { registryDeferred } from './agent-registry-fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function fixture(now = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-codex-update-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let version = '0.159.3', managed = true, upgrades = 0, failLocal = false, failWorkers = false, waiting = 0;
  const calls: { version: string; apply: boolean }[] = [];
  const local = () => ({ version, managed, executable: '/brew/bin/codex', brew: '/brew/bin/brew' });
  const options = { filename: join(directory, 'version.json'), now, installation: {
    inspect: async () => local(), available: async () => '0.163.0',
    upgrade: async () => { upgrades++; if (failLocal) throw new Error('Download failed'); version = '0.163.0'; return local(); }, dispose() {},
  }, workers: async (v: string, apply: boolean, _report?: CodexUpdateReporter): Promise<CodexWorkerVersions> => {
    calls.push({ version: v, apply });
    return { versions: [apply && !failWorkers && !waiting ? v : '0.159.3'], pending: failWorkers || waiting || !apply ? 1 : 0,
      waiting, errors: failWorkers ? ['Docker unavailable'] : [] };
  } };
  const service = new CodexUpdateService(options); cleanup.push(() => service.dispose());
  return { service, calls, options, upgrades: () => upgrades, setVersion: (v: string) => { version = v; },
    unmanaged: () => { managed = false; }, failLocal: () => { failLocal = true; }, failWorkers: () => { failWorkers = true; },
    wait: (n: number) => { waiting = n; } };
}
test('checks versions without installing and upgrades local before persisting and synchronizing workers', async () => {
  const f = fixture();
  const checked = await f.service.check();
  expect(checked.installedVersion).toBe('0.159.3'); expect(checked.availableVersion).toBe('0.163.0');
  expect(f.upgrades()).toBe(0); expect(f.calls).toEqual([{ version: '0.159.3', apply: false }]);
  const states: string[] = []; const unsubscribe = f.service.subscribe(s => states.push(s.phase));
  const result = await f.service.install(); unsubscribe();
  expect(result.error).toBeNull(); expect(result.installedVersion).toBe('0.163.0'); expect(result.workers.pending).toBe(0);
  expect(f.calls.at(-1)).toEqual({ version: '0.163.0', apply: true });
  expect(states).toContain('local'); expect(states).toContain('workers');
  expect(JSON.parse(readFileSync(f.options.filename, 'utf8'))).toEqual({ version: '0.163.0' });
  const restored = new CodexUpdateService(f.options); cleanup.push(() => restored.dispose());
  expect(restored.workerVersion()).toBe('0.163.0');
});
test('up-to-date local installation can update workers without rerunning Homebrew', async () => {
  const f = fixture(); f.setVersion('0.163.0');
  expect((await f.service.syncWorkers()).workers.pending).toBe(0);
  expect(f.upgrades()).toBe(0); expect(f.calls.at(-1)).toEqual({ version: '0.163.0', apply: true });
});
test('session process guidance appears only after an actual local upgrade', async () => {
  const f = fixture();
  const guidance = 'Existing local sessions keep their running process';
  expect((await f.service.check()).detail).not.toContain(guidance);
  const updated = await f.service.install();
  expect(updated.detail).toContain('Local and workers: 0.163.0.');
  expect(updated.detail).toContain(guidance);
  f.options.workers = async () => ({ versions: ['0.163.0'], pending: 0, waiting: 0, errors: [] });
  expect((await f.service.check()).detail).toBe('Local and workers: 0.163.0.');
  expect((await f.service.install()).detail).not.toContain(guidance);
  expect((await f.service.syncWorkers()).detail).not.toContain(guidance);
  expect(f.upgrades()).toBe(1);
});
test('Docker inspection failure does not hide the available local release', async () => {
  const f = fixture(); f.failWorkers();
  const result = await f.service.check();
  expect(result.installedVersion).toBe('0.159.3');
  expect(result.availableVersion).toBe('0.163.0');
  expect(result.workers.pending).toBe(1);
  expect(result.error).toContain('Workers pending');
  expect(f.upgrades()).toBe(0);
});
test('a successful Homebrew command with an unchanged executable cannot mark the update complete', async () => {
  const f = fixture();
  f.options.installation.upgrade = f.options.installation.inspect;
  const result = await f.service.install();
  expect(result.error).toContain('still older');
  expect(result.installedVersion).toBe('0.159.3');
  expect(f.calls).toEqual([]);
});
test('local failure never attempts worker update; partial worker failure preserves installed version', async () => {
  const f = fixture(); f.failLocal();
  expect((await f.service.install()).error).toBe('Download failed'); expect(f.calls).toEqual([]);
  const g = fixture(); g.failWorkers();
  const result = await g.service.install();
  expect(result.installedVersion).toBe('0.163.0'); expect(result.error).toContain('Workers pending');
  expect(g.service.workerVersion()).toBe('0.163.0');
});
test('busy workers remain pending and duplicate update clicks share one operation', async () => {
  const f = fixture(); f.wait(1);
  const [a, b] = await Promise.all([f.service.install(), f.service.install()]);
  expect(f.upgrades()).toBe(1); expect(a).toEqual(b); expect(a.workers.waiting).toBe(1);
  expect(a.detail).toContain('Waiting for active tasks');
  f.wait(0); expect((await f.service.syncWorkers()).workers.pending).toBe(0);
});

test('version mismatch alone is not reported as waiting for active tasks', async () => {
  const f = fixture(); f.setVersion('0.163.0');
  const result = await f.service.check();
  expect(result.workers.pending).toBe(1);
  expect(result.workers.waiting).toBe(0);
  expect(result.detail).toContain('Worker update available');
  expect(result.detail).not.toContain('active tasks');
});

test('progress replaces stale detail, records real activity and clears on completion or timeout', async () => {
  let now = 1000;
  const f = fixture(() => now); f.setVersion('0.163.0');
  await f.service.check();
  const entered = registryDeferred<void>(), done = registryDeferred<CodexWorkerVersions>();
  let report: CodexUpdateReporter | undefined;
  f.options.workers = async (_v, _apply, receive) => { report = receive; receive?.('dependencies'); entered.resolve(); return done.promise; };
  const states: CodexUpdateState[] = [];
  f.service.subscribe(s => states.push(s));
  const updating = f.service.syncWorkers();
  await entered.promise;
  expect(states[0]?.detail).not.toContain('Click to update');
  expect(f.service.snapshot().detail).toBe('Preparing worker dependencies…');
  expect((await f.service.get()).busy).toBe(true);
  expect(f.service.snapshot().progress).toEqual({ stage: 'dependencies', startedAt: 1000, updatedAt: 1000 });
  now = 65_000;
  expect(f.service.snapshot().progress?.updatedAt).toBe(1000);
  report?.();
  expect(states.at(-1)?.progress?.updatedAt).toBe(65_000);
  now = 66_000; report?.('verifying-worker');
  expect(states.at(-1)?.progress?.stage).toBe('verifying-worker');
  done.resolve({ versions: ['0.163.0'], pending: 0, waiting: 0, errors: [] });
  expect((await updating).progress).toBeNull();
  const revision = f.service.snapshot().revision;
  report?.('dependencies');
  expect(f.service.snapshot().revision).toBe(revision);
  const lateReport = report;
  f.options.workers = async () => {
    lateReport?.('dependencies');
    expect(f.service.snapshot().progress?.stage).toBe('checking-workers');
    return { versions: [], pending: 1, waiting: 0, errors: ['Docker command timed out.'] };
  };
  const failed = await f.service.syncWorkers();
  expect(failed.busy).toBe(false);
  expect(failed.progress).toBeNull();
  expect(failed.error).toContain('timed out');
  expect(failed.error).toContain('Retry Update workers');
});
test('unmanaged installation cannot invoke Homebrew but may synchronize workers', async () => {
  const f = fixture(); f.unmanaged();
  expect((await f.service.install()).error).toContain('original installer');
  expect(f.upgrades()).toBe(0); expect(f.calls).toEqual([]);
  expect((await f.service.syncWorkers()).error).toBeNull();
});
test('release parser rejects command injection, invalid output and lexical ordering', () => {
  expect(parseCodexVersion('codex-cli 0.163.0\n')).toBe('0.163.0');
  expect(newerCodexVersion('0.163.0', '0.99.0')).toBe(true);
  for (const v of ['latest','0.163.0; touch /tmp/x','../codex','0.163.0-beta',true]) expect(() => codexVersion(v)).toThrow();
  expect(insideCodexCask('/brew/Caskroom/codex/0.163.0/bin', '/brew/Caskroom/codex')).toBe(true);
  expect(insideCodexCask('/brew/Caskroom/codex-other/bin', '/brew/Caskroom/codex')).toBe(false);
});
test('installer rechecks ownership and invokes only the fixed Homebrew cask command', async () => {
  const calls: string[][] = []; let path = '/brew/Caskroom/codex/0.163.0/codex';
  const progress: (string | undefined)[] = [];
  const installation = createCodexInstallation({ executable: () => '/brew/bin/codex', brew: () => '/brew/bin/brew',
    realpath: async p => String(p) === '/brew/bin/codex' ? path : String(p),
    command: async (_file, args, options) => {
      calls.push(args); options.output?.('private installation output');
      return args[0] === '--version' ? 'codex-cli 0.163.0' : args[0] === '--caskroom' ? '/brew/Caskroom/codex' : '';
    },
  }); cleanup.push(() => installation.dispose());
  expect((await installation.inspect()).managed).toBe(true);
  await installation.upgrade(stage => progress.push(stage));
  expect(progress).toEqual(['updating-local', undefined, 'verifying-local']);
  expect(calls.filter(a => a[0] === 'upgrade')).toEqual([['upgrade','--cask','codex']]);
  path = '/other/codex'; let rejected = false;
  try { await installation.upgrade(); } catch { rejected = true; }
  expect(rejected).toBe(true); expect(calls.filter(a => a[0] === 'upgrade')).toHaveLength(1);
});
