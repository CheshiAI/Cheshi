import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FlashActivation } from '../lib/flash/activation.mts';
import { FlashInstaller, type FlashInstallCommand } from '../lib/flash/installer.mts';
import { FLASH_MODEL, FLASH_MODEL_FILES, FLASH_MODEL_REVISION, FLASH_REVISION,
  flashInstallationPaths, flashModelSnapshot, inspectFlashInstallation } from '../lib/flash/installation.mts';
import type { FlashReadiness } from '../shared/settings.ts';
import { FlashError } from '../lib/flash/client.mts';
import { deferred, rejection } from './flash-test-helpers.ts';

async function installation() {
  const root = await mkdtemp(join(tmpdir(), 'flash-install-test-'));
  const paths = flashInstallationPaths(root, { CHESHI_FLASH_MODEL_CACHE: join(root, 'cache') });
  paths.executable = paths.managedExecutable;
  const create = async () => {
    await mkdir(dirname(paths.executable), { recursive: true });
    await writeFile(paths.executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    for (const file of FLASH_MODEL_FILES) {
      const target = join(flashModelSnapshot(paths.modelCache), file);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, '{}');
    }
  };
  return { root, paths, create, close: () => rm(root, { recursive: true, force: true }) };
}

test('preflight rejects missing executables, nonexecutables, missing Python and incomplete model snapshots', async () => {
  const f = await installation();
  try {
    expect((await inspectFlashInstallation(f.paths)).ready).toBe(false);
    await f.create(); expect((await inspectFlashInstallation(f.paths)).ready).toBe(true);
    await chmod(f.paths.executable, 0o600);
    expect((await inspectFlashInstallation(f.paths)).ready).toBe(false);
    await chmod(f.paths.executable, 0o700);
    await writeFile(f.paths.executable, `#!${join(f.root, 'missing-python')}\n`);
    expect((await inspectFlashInstallation(f.paths)).detail).toContain('Python');
    await f.create();
    const model = join(flashModelSnapshot(f.paths.modelCache), 'model.safetensors');
    await writeFile(model, ''); expect((await inspectFlashInstallation(f.paths)).ready).toBe(false);
    await rm(model); await createSymbolicLink(join(f.root, 'missing-blob'), model);
    expect((await inspectFlashInstallation(f.paths)).detail).toContain('model.safetensors');
    await writeFile(join(f.root, 'missing-blob'), 'model');
    expect((await inspectFlashInstallation(f.paths)).ready).toBe(true);
  } finally { await f.close(); }
});

function activation() {
  let saved = false, starts = 0, releases = 0;
  let readiness: FlashReadiness = { ready: true, detail: 'Files available' };
  let prepare = async () => {};
  const seen: boolean[] = [];
  const gate = new FlashActivation({ preferences: { getFlashEnabled: () => saved, setFlashEnabled: value => saved = value },
    inspect: async () => readiness,
    createHost: () => { starts++; return { transaction: async (operation, signal) => {
      await prepare(); signal.throwIfAborted(); return operation({ socketPath: '/unused', token: 'fixture' });
    }, release: async () => { releases++; } }; } });
  gate.subscribeFlashEnabled(value => seen.push(value));
  return { gate, seen, saved: () => saved, starts: () => starts, releases: () => releases,
    setSaved: (value: boolean) => { saved = value; },
    status: (value: FlashReadiness) => { readiness = value; }, prepare: (value: () => Promise<void>) => { prepare = value; } };
}

test('activation never starts or saves ON when prerequisites are missing; OFF always works', async () => {
  const f = activation();
  try {
    f.status({ ready: false, detail: 'Missing model' });
    expect(await rejection(() => f.gate.setFlashEnabled(true))).toMatchObject({ message: 'Missing model' });
    expect(f.saved()).toBe(false); expect(f.starts()).toBe(0); expect(f.seen).not.toContain(true);
    expect(await f.gate.setFlashEnabled(false)).toBe(false);
    expect(() => f.gate.setFlashEnabled('true')).toThrow('boolean');
  } finally { await f.gate.dispose(); }
});

test('concurrent enables share model loading and publish ON only after success', async () => {
  const f = activation(), load = deferred<void>();
  f.prepare(() => load.promise);
  try {
    const first = f.gate.setFlashEnabled(true), second = f.gate.setFlashEnabled(true);
    expect(first).toBe(second); expect(f.saved()).toBe(false); expect(f.gate.getFlashEnabled()).toBe(false);
    load.resolve(); expect(await first).toBe(true);
    expect(f.saved()).toBe(true); expect(f.starts()).toBe(1); expect(f.seen).toEqual([true]);
    await f.gate.setFlashEnabled(false);
  } finally { load.resolve(); await f.gate.dispose(); }
  expect(f.releases()).toBe(1);
});

test('model loading failure keeps OFF, releases the host and remains retryable', async () => {
  const f = activation();
  try {
    f.prepare(async () => { throw new FlashError('not_ready', 'Flash model initialization failed'); });
    await rejection(() => f.gate.setFlashEnabled(true));
    expect(f.saved()).toBe(false); expect(f.gate.getFlashEnabled()).toBe(false);
    expect((await f.gate.readiness()).detail).toContain('initialization failed');
    f.prepare(async () => {}); expect(await f.gate.setFlashEnabled(true)).toBe(true);
    expect(f.starts()).toBe(2);
  } finally { await f.gate.dispose(); }
});

test('OFF cancels a pending enable so a late model load cannot re-enable Flash', async () => {
  const f = activation(), entered = deferred<void>(), load = deferred<void>();
  f.prepare(async () => { entered.resolve(); await load.promise; });
  try {
    const enabling = rejection(() => f.gate.setFlashEnabled(true));
    await entered.promise; await f.gate.setFlashEnabled(false); load.resolve();
    expect(await enabling).toMatchObject({ code: 'canceled' });
    expect(f.saved()).toBe(false); expect(f.seen).not.toContain(true);
  } finally { load.resolve(); await f.gate.dispose(); }
});

test('restart treats saved ON as unverified and clears it when files are missing', async () => {
  const f = activation();
  try {
    f.setSaved(true); f.status({ ready: false, detail: 'Missing executable' });
    expect(f.gate.getFlashEnabled()).toBe(false); await f.gate.restore();
    expect(f.saved()).toBe(false); expect(f.starts()).toBe(0);
  } finally { await f.gate.dispose(); }
});

test('installer pins source, frozen dependencies and model; concurrent requests share progress and never enable memory', async () => {
  const f = await installation(), hold = deferred<void>(), entered = deferred<void>();
  const calls: { file: string; args: string[] }[] = [];
  const run: FlashInstallCommand = async (file, args, options) => {
    calls.push({ file, args });
    if (file === 'gh') {
      entered.resolve(); await hold.promise;
      const source = join(args[3]!, 'src/cheshi_flash'); await mkdir(source, { recursive: true });
      await writeFile(join(source, 'identity.json'), JSON.stringify({ model: FLASH_MODEL, revision: FLASH_MODEL_REVISION }));
    }
    if (args[0] === 'rev-parse') return FLASH_REVISION;
    if (file !== 'git' && args[0] === '-c') { expect(args).toContain(FLASH_MODEL_REVISION); await f.create(); }
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    return '';
  };
  const installer = new FlashInstaller({ userData: f.root, paths: f.paths, enabled: () => false,
    readiness: () => inspectFlashInstallation(f.paths), run,
    python: { prepare: async () => ({ executable: '/fixture/python', id: 'fixture', version: '3.14.8' }), dispose() {} } });
  try {
    const first = installer.install(), second = installer.install(); expect(first).toBe(second);
    await entered.promise; expect(await installer.status()).toMatchObject({ ready: false, installing: true });
    hold.resolve(); expect((await first).ready).toBe(true); expect(installer.isInstalling()).toBe(false);
    expect(calls.find(call => call.args[0] === 'sync')?.args).toEqual(['sync', '--frozen', '--extra', 'model', '--no-dev', '--python', '/fixture/python']);
    expect(calls.some(call => call.args.includes(FLASH_REVISION))).toBe(true);
    expect((await installer.status()).ready).toBe(true);
    await installer.install(); expect(calls.filter(call => call.file === 'gh').length).toBe(1);
    expect(await readFile(f.paths.executable, 'utf8')).toContain('exit 0');
  } finally { hold.resolve(); installer.dispose(); await f.close(); }
});

test('installer failures redact child diagnostics and allow retry without claiming readiness', async () => {
  const f = await installation();
  const installer = new FlashInstaller({ userData: f.root, paths: f.paths, enabled: () => false,
    readiness: () => inspectFlashInstallation(f.paths), run: async () => { throw new Error('credential=private-fixture'); },
    python: { prepare: async () => { throw new Error('unused'); }, dispose() {} } });
  try {
    const failure = await rejection(() => installer.install());
    expect(String(failure)).not.toContain('private-fixture');
    expect(await installer.status()).toMatchObject({ ready: false });
    expect(installer.isInstalling()).toBe(false);
    await rejection(() => installer.install());
  } finally { installer.dispose(); await f.close(); }
});
