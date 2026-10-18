import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FlashActivation } from '../lib/flash/activation.mts';
import { FLASH_MODEL_FILES,
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
