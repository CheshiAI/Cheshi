import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink as createSymbolicLink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { readVoiceWaveform, saveVoiceAudio } from '../lib/voice-media-file.mts';
import { voiceWaveform } from '../shared/voice-transcription.ts';
import { registerVoiceDetailIpc } from '../lib/voice-detail-ipc.mts';
import { registerVoiceAudioProtocol } from '../lib/voice-audio.mts';

test('waveform boundary rejects malformed or oversized data', () => {
  assert.deepEqual(voiceWaveform({ duration: 1, peaks: [0, 0.5, 1] }), { duration: 1, peaks: [0, 0.5, 1] });
  for (const value of [null, { duration: 0, peaks: [1] }, { duration: 1, peaks: [] },
    { duration: 1, peaks: Array(2049).fill(0) }, ...[NaN, Infinity, -1, 2, '0.5'].map(value => ({ duration: 1, peaks: [value] }))]) {
    assert.throws(() => voiceWaveform(value));
  }
});

test('audio export copies the prepared format, protects source paths, and cleans cancelled or failed exports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-save-test-'));
  const original = join(directory, 'memo.qta'), prepared = join(directory, 'prepared.m4a'), saved = join(directory, 'saved.m4a');
  try {
    await writeFile(original, 'original'); await writeFile(prepared, 'playable'); await writeFile(saved, 'previous');
    assert.equal(await saveVoiceAudio(prepared, original, async name => { assert.equal(name, 'memo.m4a'); return saved; }, () => false), 'saved');
    assert.equal(await readFile(saved, 'utf8'), 'playable');
    assert.equal(await readFile(original, 'utf8'), 'original');
    assert.equal(await saveVoiceAudio(prepared, original, async () => null, () => false), 'cancelled');
    assert.equal(await saveVoiceAudio(prepared, original, async () => saved, () => true), 'cancelled');
    assert.equal(await saveVoiceAudio(prepared, original, async () => original, () => false), 'error');
    const alias = join(directory, 'alias.m4a'); await createSymbolicLink(original, alias);
    assert.equal(await saveVoiceAudio(prepared, original, async () => alias, () => false), 'error');
    let checks = 0;
    assert.equal(await saveVoiceAudio(prepared, original, async () => saved, () => ++checks > 1), 'cancelled');
    assert.equal(await readFile(saved, 'utf8'), 'playable');
    assert.equal(await saveVoiceAudio(prepared, original, async () => join(directory, 'missing', 'file.m4a'), () => false), 'error');
    assert.equal((await readdir(directory)).some(name => name.startsWith('.cheshi-voice-export-')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native waveform follows actual PCM energy and handles cancellation', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-waveform-test-'));
  try {
    const file = join(directory, 'tone.wav'), samples = 16000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    for (let i = samples / 2; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI / 8) * 16000), 44 + i * 2);
    await writeFile(file, wav);
    const result = await readVoiceWaveform(file, new AbortController().signal);
    assert.ok(result); assert.equal(result.duration, 2); assert.equal(result.peaks.length, 512);
    assert.equal(Math.max(...result.peaks.slice(0, 250)), 0);
    assert.ok(Math.max(...result.peaks.slice(260)) > 0.45);
    const controller = new AbortController(); controller.abort();
    assert.equal(await readVoiceWaveform(file, controller.signal), null);
    assert.equal(await readVoiceWaveform(join(directory, 'missing'), new AbortController().signal), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('media IPC permits only the current owner token and cancels saving when its recording is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-media-ipc-'));
  const original = join(directory, 'memo.wav'), destination = join(directory, 'saved.wav');
  let handler!: Parameters<IpcMain['handle']>[1];
  let dialogs = 0;
  let selectPath!: (value: string | null) => void;
  let dialogReady!: () => void;
  const ready = new Promise<void>(resolve => { dialogReady = resolve; });
  const choice = new Promise<string | null>(resolve => { selectPath = resolve; });
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, session: { protocol: { handle() {} } } });
  const event = { sender } as unknown as IpcMainInvokeEvent;
  registerVoiceAudioProtocol(event.sender.session.protocol);
  const ipc = registerVoiceDetailIpc({ ipcMain: { handle(_channel, callback) { handler = callback; } }, assertSender() {},
    resolveAudio: async () => original, chooseSavePath: async () => { dialogs++; dialogReady(); return choice; } });
  try {
    await writeFile(original, 'audio');
    const url = await handler(event, 'openAudio', '1') as string;
    assert.equal(typeof url, 'string');
    assert.equal(await handler(event, 'saveAudio', 'another-token'), 'cancelled');
    assert.equal(await handler(event, 'waveform', 'another-token'), null);
    assert.equal(dialogs, 0);
    const saving = handler(event, 'saveAudio', url);
    await ready;
    assert.equal(await handler(event, 'saveAudio', url), 'cancelled');
    await handler(event, 'releaseAudio', url);
    selectPath(destination);
    assert.equal(await saving, 'cancelled');
    assert.equal(await handler(event, 'waveform', url), null);
    assert.deepEqual(await readdir(directory), ['memo.wav']);
  } finally { selectPath?.(null); await ipc.dispose(); await rm(directory, { recursive: true, force: true }); }
});
