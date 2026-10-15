import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createVoiceAudioPreparation } from '../lib/voice-audio-preparation.mts';
import { registerVoiceDetailIpc } from '../lib/voice-detail-ipc.mts';
import { registerVoiceAudioProtocol } from '../lib/voice-audio.mts';

test('QTA conversion is shared by playback and transcription, keeps source untouched, and cleans temporary audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-preparation-test-'));
  let calls = 0;
  const preparation = createVoiceAudioPreparation({ directory, run: async (command, emit) => {
    calls++;
    const request = command as { path: string; output: string; action: string };
    assert.equal(request.path, '/original.qta'); assert.equal(request.action, 'prepareAudio');
    await writeFile(request.output, 'converted audio'); emit({ prepared: true });
  } });
  try {
    const [playback, transcript] = await Promise.all([preparation.prepare('/original.qta'), preparation.prepare('/original.qta')]);
    assert.equal(calls, 1); assert.equal(playback.path, transcript.path);
    playback.release(); assert.equal((await readdir(directory)).length, 1);
    transcript.release(); await preparation.dispose();
    assert.deepEqual(await readdir(directory), []);
  } finally { await preparation.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('ordinary formats are passed through and failed conversions can retry without leaving partial files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-preparation-test-'));
  let failed = true, calls = 0;
  const preparation = createVoiceAudioPreparation({ directory, run: async (_command, emit) => {
    calls++; emit({ prepared: failed ? 'true' : true });
  } });
  try {
    const plain = await preparation.prepare('/original.m4a'); assert.equal(plain.path, '/original.m4a'); plain.release();
    assert.equal(calls, 0);
    await assert.rejects(preparation.prepare('/original.qta'));
    failed = false;
    const retry = await preparation.prepare('/original.qta'); retry.release();
    await preparation.dispose(); assert.equal(calls, 2); assert.deepEqual(await readdir(directory), []);
  } finally { await preparation.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('workspace disposal aborts pending preparation and removes its partial output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-preparation-test-'));
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const preparation = createVoiceAudioPreparation({ directory, run: async (_command, _emit, signal) => {
    started(); await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  } });
  try {
    const pending = assert.rejects(preparation.prepare('/original.qta'));
    await ready; await preparation.dispose(); await pending;
    assert.deepEqual(await readdir(directory), []);
  } finally { await preparation.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('ordinary audio failures and stale selections return handled IPC results while unauthorized callers still fail', async () => {
  let handler!: Parameters<IpcMain['handle']>[1];
  let allowed = true;
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, session: { protocol: { handle() {} } } });
  const event = { sender } as unknown as IpcMainInvokeEvent;
  registerVoiceAudioProtocol(event.sender.session.protocol);
  let resolveOld!: (filename: string) => void;
  const old = new Promise<string>(resolve => { resolveOld = resolve; });
  const ipc = registerVoiceDetailIpc({ ipcMain: { handle(_channel, value) { handler = value; } },
    assertSender() { if (!allowed) throw new Error('Unauthorized'); },
    resolveAudio: async id => { if (id === '1') throw new Error('missing'); return id === '2' ? old : '/fixture.m4a'; },
  });
  try {
    assert.deepEqual(await handler(event, 'openAudio', '1'), { error: 'audio-unavailable' });
    const pending = handler(event, 'openAudio', '2');
    assert.match(await handler(event, 'openAudio', '3') as string, /^cheshi-voice:/);
    resolveOld('/old.m4a');
    assert.deepEqual(await pending, { error: 'cancelled' });
    allowed = false;
    await assert.rejects(handler(event, 'openAudio', '3') as Promise<unknown>, /Unauthorized/);
  } finally { await ipc.dispose(); }
});
