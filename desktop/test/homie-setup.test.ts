import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IpcRenderer } from 'electron';
import { HomieSetup } from '../lib/homie-setup.mts';
import { SetupCommandError, runSetupCommand, type SetupCommand } from '../lib/homie-setup-command.mts';
import { parseHomieSetupStatus } from '../shared/homie-setup.ts';
import { createSettingsApi } from '../lib/settings-preload.cts';
import { SETTINGS_CHANNELS } from '../shared/settings.ts';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function rejection(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return error; }
  throw new Error('Expected rejection');
}
function fixture(installed = ['brew', 'docker', 'colima']) {
  const tools = new Set(installed), calls: { file: string; args: string[] }[] = [];
  let running = false, endpoint = 'unix:///fixture/.colima/default/docker.sock';
  let security = false;
  const hash = createHash('sha256').update(readFileSync(new URL('../../experiments/codex-specialists/security/cheshi-codex-bwrap.apparmor', import.meta.url))).digest('hex');
  const run: SetupCommand = async (file, args, options) => {
    calls.push({ file, args });
    expect(options.env.DOCKER_HOST).toBeUndefined();
    if (file.endsWith('/brew')) { tools.add(args.at(-1)!); return ''; }
    if (file.endsWith('/colima')) {
      if (args.includes('start')) { running = true; return ''; }
      if (options.input) { security = true; return ''; }
      return security ? `${hash}  /etc/apparmor.d/cheshi-codex-bwrap` : '';
    }
    if (args.includes('inspect')) return JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]);
    if (!running) throw new SetupCommandError('Colima is stopped.');
    return '29.0';
  };
  const options = { platform: 'darwin', home: '/fixture', find: (name: 'brew' | 'docker' | 'colima') => tools.has(name) ? `/tools/${name}` : null, run };
  return { options, calls, tools, run, setRunning: () => { running = true; }, setEndpoint: (value: string) => { endpoint = value; } };
}

test('installed tools are distinct from a verified local Docker connection', async () => {
  const f = fixture(), service = new HomieSetup(f.options);
  expect(await service.status()).toMatchObject({ brew: true, docker: true, colima: true, connected: false });
  expect(await service.start()).toMatchObject({ connected: true, securityReady: true });
  expect(f.calls.find(call => call.file.endsWith('/colima'))?.args)
    .toEqual(['--profile', 'default', 'start', '--runtime', 'docker', '--activate=false']);
  expect(f.calls.filter(call => call.args.includes('info')).every(call => call.args.includes('unix:///fixture/.colima/default/docker.sock'))).toBe(true);
  service.dispose();
});

test('only missing tools are installed and installation does not start a VM', async () => {
  const f = fixture(['brew', 'docker']), service = new HomieSetup(f.options);
  expect(await service.install()).toMatchObject({ docker: true, colima: true, connected: false, busy: false });
  expect(f.calls.filter(call => call.file === '/tools/brew')).toEqual([{ file: '/tools/brew', args: ['install', '--formula', 'colima'] }]);
  expect(f.calls.some(call => call.file.endsWith('/colima'))).toBe(false);
  service.dispose();
});

test('missing Homebrew and unsupported hosts never launch installation commands', async () => {
  const f = fixture([]), service = new HomieSetup(f.options);
  expect((await service.install()).error).toContain('brew.sh');
  expect(f.calls).toEqual([]);
  const unsupported = new HomieSetup({ ...f.options, platform: 'linux' });
  expect((await unsupported.status()).supported).toBe(false);
  expect(String(await rejection(unsupported.install()))).toContain('macOS');
  expect(f.calls).toEqual([]);
  service.dispose(); unsupported.dispose();
});

test('remote or mismatched contexts never receive an engine request', async () => {
  const f = fixture(); f.setEndpoint('tcp://other-host:2375');
  const service = new HomieSetup(f.options);
  expect((await service.status()).connected).toBe(false);
  expect(f.calls.some(call => call.args.includes('info'))).toBe(false);
  service.dispose();
});

test('all windows share operation progress and duplicate requests cannot launch another command', async () => {
  const f = fixture(['brew']), entered = createDeferred(), hold = createDeferred();
  const service = new HomieSetup({ ...f.options, run: async (file, args, options) => {
    if (file.endsWith('/brew')) {
      options.output?.('==> Downloading https://private-fixture\n'); entered.resolve(); await hold.promise;
    }
    return f.run(file, args, options);
  } });
  try {
    const first = service.install(); await entered.promise;
    expect(service.install()).toBe(first); expect(service.start()).toBe(first);
    const status = await service.status();
    expect(status.busy).toBe(true); expect(status.startedAt).toBeGreaterThan(0);
    expect(status.detail).toBe('Downloading colima and its dependencies…');
    expect(JSON.stringify(status)).not.toContain('private-fixture');
    hold.resolve(); expect((await first).busy).toBe(false);
    expect(f.calls.filter(call => call.file.endsWith('/brew')).length).toBe(2);
  } finally { hold.resolve(); service.dispose(); }
});

test('failed installations expose a safe reason, refresh partial installs and allow retry', async () => {
  const f = fixture(['brew']); let fail = true;
  const service = new HomieSetup({ ...f.options, run: async (file, args, options) => {
    if (args.at(-1) === 'docker' && fail) throw new Error('credential=private-fixture');
    return f.run(file, args, options);
  } });
  const failed = await service.install();
  expect(failed.busy).toBe(false); expect(failed.error).toContain('Setup failed');
  expect(failed.error).not.toContain('private-fixture');
  expect((await service.status()).colima).toBe(true);
  fail = false;
  expect((await service.install()).error).toBeUndefined();
  expect(f.calls.filter(call => call.file.endsWith('/brew') && call.args.at(-1) === 'colima').length).toBe(1);
  service.dispose();
});

test('preload validates every Homies reply and rejects non-literal booleans', async () => {
  const service = new HomieSetup(fixture([]).options), status = await service.status();
  const calls: string[] = []; let reply: unknown = status;
  const ipc = Object.assign(new EventEmitter(), { invoke: async (channel: string) => { calls.push(channel); return reply; } });
  const api = createSettingsApi(ipc as IpcRenderer);
  expect(await api.getHomieSetup()).toEqual(status);
  expect(await api.installHomieTools()).toEqual(status);
  expect(await api.startHomieEngine()).toEqual(status);
  expect(calls).toEqual([SETTINGS_CHANNELS.getHomieSetup, SETTINGS_CHANNELS.installHomieTools, SETTINGS_CHANNELS.startHomieEngine]);
  for (const malformed of [{ ...status, busy: 'true' }, { ...status, startedAt: -1 }, { ...status, connected: 1 }, { ...status, securityReady: 'true' }]) {
    reply = malformed;
    expect(await rejection(api.getHomieSetup())).toBeInstanceOf(TypeError);
  }
  expect(() => parseHomieSetupStatus(null)).toThrow(); service.dispose();
});

test('a successful start command cannot claim readiness if the engine is still unavailable', async () => {
  const f = fixture();
  const service = new HomieSetup({ ...f.options, run: async (file, args, options) => {
    if (file.endsWith('/colima')) return '';
    return f.run(file, args, options);
  } });
  const status = await service.start();
  expect(status.connected).toBe(false);
  expect(status.error).toContain('Colima is stopped');
  service.dispose();
});

test('a delayed diagnostic cannot overwrite a completed setup operation', async () => {
  const f = fixture(), entered = createDeferred(), hold = createDeferred();
  let first = true;
  const service = new HomieSetup({ ...f.options, run: async (file, args, options) => {
    if (first && args.includes('inspect')) {
      first = false; entered.resolve(); await hold.promise;
      throw new SetupCommandError('Old disconnected result');
    }
    return f.run(file, args, options);
  } });
  try {
    const oldCheck = service.status(); await entered.promise;
    expect((await service.start()).connected).toBe(true);
    hold.resolve();
    expect((await oldCheck).connected).toBe(true);
    expect((await service.status()).detail).not.toContain('Old disconnected');
  } finally { hold.resolve(); service.dispose(); }
});

test('disposing setup cancels the running command and clears busy state', async () => {
  const f = fixture(['brew']), entered = createDeferred();
  const service = new HomieSetup({ ...f.options, run: async (_file, _args, options) => {
    entered.resolve();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      reject(new SetupCommandError('Operation stopped.'));
    }, { once: true }));
  } });
  const pending = service.install(); await entered.promise;
  service.dispose();
  expect(await pending).toMatchObject({ busy: false, error: 'Installing colima with Homebrew… Operation stopped.' });
});

test('native subprocess diagnostics are classified without exposing raw stderr', async () => {
  const error = await rejection(runSetupCommand('/bin/sh', ['-c', 'echo "Permission denied credential=private-fixture" >&2; exit 1'],
    { env: { PATH: '/usr/bin:/bin' }, timeout: 5000, signal: new AbortController().signal }));
  expect(String(error)).toContain('Permission denied'); expect(String(error)).not.toContain('private-fixture');
});

test('a connected engine without the bundled profile needs preparation and repeated preparation is idempotent', async () => {
  const f = fixture(); f.setRunning();
  let installs = 0;
  const service = new HomieSetup({ ...f.options, run: async (file, args, options) => {
    if (options.input) {
      installs++;
      expect(options.input).toContain('profile cheshi-codex-bwrap');
      expect(args).toContain('default'); expect(args).toContain('sudo'); expect(args).toContain('-n');
      expect(args.join(' ')).not.toContain(options.input);
    }
    return f.run(file, args, options);
  } });
  try {
    expect(await service.status()).toMatchObject({ connected: true, securityReady: false });
    expect(installs).toBe(0);
    const prepared = await service.start();
    expect(prepared).toMatchObject({ connected: true, securityReady: true });
    expect(prepared.error).toBeUndefined();
    expect(await service.start()).toMatchObject({ securityReady: true });
    expect(installs).toBe(1);
    expect(f.calls.some(call => call.args.includes('start'))).toBe(false);
  } finally { service.dispose(); }
});

test('profile installation failure survives status checks, and a successful command without verified registration is not ready', async () => {
  const f = fixture(); f.setRunning();
  let fail = true;
  const service = new HomieSetup({ ...f.options, run: async (file, args, options) => {
    if (options.input) {
      if (fail) throw new SetupCommandError('Permission denied.');
      return ''; // Simulate a successful command that did not load the expected profile.
    }
    return f.run(file, args, options);
  } });
  try {
    expect((await service.start()).error).toContain('Permission denied');
    expect(await service.status()).toMatchObject({ connected: true, securityReady: false });
    expect((await service.status()).error).toContain('Permission denied');
    fail = false;
    expect((await service.start()).error).toContain('could not be verified');
    expect((await service.status()).securityReady).toBe(false);
  } finally { service.dispose(); }
});

test('an outdated profile is not ready and remote contexts never receive security writes', async () => {
  const f = fixture(); f.setRunning();
  const service = new HomieSetup({ ...f.options, run: async (file, args, options) => {
    if (args.includes('ssh')) return 'old-hash  /etc/apparmor.d/cheshi-codex-bwrap';
    return f.run(file, args, options);
  } });
  try {
    expect((await service.status()).securityReady).toBe(false);
    f.setEndpoint('tcp://remote:2375'); f.calls.length = 0;
    expect((await service.start()).error).toContain('default local Colima');
    expect(f.calls.some(call => call.args.includes('ssh'))).toBe(false);
  } finally { service.dispose(); }
});

test('profile transfer uses native subprocess stdin without rewriting its contents', async () => {
  const input = 'profile fixture {\n  # $HOME `literal`\n}\n';
  const output = await runSetupCommand('/bin/cat', [], { env: { PATH: '/usr/bin:/bin' },
    timeout: 5000, signal: new AbortController().signal, input });
  expect(output).toBe(input);
});

test('packaging retains Homies setup services and the shared security profile', async () => {
  const { loadForgeConfiguration } = await import('./forge-test-helpers.ts');
  const config = await loadForgeConfiguration(), ignore = config.packagerConfig.ignore;
  if (typeof ignore !== 'function') throw new Error('Missing packaging filter');
  for (const path of ['/desktop/lib/homie-setup.mts', '/desktop/lib/homie-setup-command.mts', '/desktop/lib/homie-security.mts', '/desktop/shared/homie-setup.ts']) {
    expect(ignore(path)).toBe(false);
  }
  const { SPECIALIST_WORKER_FILES } = await import('../../scripts/prepare-specialist-worker.mts');
  expect(SPECIALIST_WORKER_FILES).toContain('security/cheshi-codex-bwrap.apparmor');
});
