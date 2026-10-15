import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, rm, realpath, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveVoiceRecordingFile } from '../lib/voice-recording-file.mts';
import { audioRange, voiceAudioResponse } from '../lib/voice-audio.mts';
import { createVoiceDetailService } from '../lib/voice-detail-service.mts';
import { runSpeechCommand, speechExecutable } from '../lib/voice-speech-process.mts';
import { voiceCapabilities, voiceTranscription } from '../shared/voice-transcription.ts';
import { loadForgeConfiguration } from './forge-test-helpers.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('audio resolver accepts only live recording rows inside the library, including realpath boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-detail-'));
  await mkdir(join(directory, 'Recordings'));
  const database = join(directory, 'Recordings', 'CloudRecordings.db');
  const db = new DatabaseSync(database);
  try {
    db.exec('CREATE TABLE ZCLOUDRECORDING(Z_PK INTEGER PRIMARY KEY,ZPATH TEXT,ZMARKEDFORDELETION INTEGER)');
    const insert = db.prepare('INSERT INTO ZCLOUDRECORDING VALUES(?,?,?)');
    await writeFile(join(directory, 'Recordings', 'test.m4a'), 'audio');
    await writeFile(join(directory, 'Recordings', 'spatial.qta'), 'QuickTime audio');
    await writeFile(join(directory, 'outside.m4a'), 'private');
    await createSymbolicLink(join(directory, 'outside.m4a'), join(directory, 'Recordings', 'escape.m4a'));
    insert.run(1, 'test.m4a', 0); insert.run(2, 'test.m4a', 1);
    insert.run(3, '../outside.m4a', 0); insert.run(4, 'escape.m4a', 0); insert.run(5, 'missing.m4a', 0);
    insert.run(7, 'spatial.qta', 0);
    assert.equal(await resolveVoiceRecordingFile(database, '1'), await realpath(join(directory, 'Recordings', 'test.m4a')));
    assert.equal(await resolveVoiceRecordingFile(database, '7'), await realpath(join(directory, 'Recordings', 'spatial.qta')));
    for (const id of ['2', '3', '4', '5', '6', '../outside', '1 OR 1=1']) {
      await assert.rejects(resolveVoiceRecordingFile(database, id));
    }
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
test('audio responses support seek ranges and revoke access without accepting paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-range-'));
  const filename = join(directory, 'audio.m4a');
  const url = 'cheshi-voice://recording/token';
  const files = new Map([[url, filename]]);
  try {
    await writeFile(filename, '0123456789');
    const ranged = await voiceAudioResponse(new Request(url, { headers: { Range: 'bytes=2-5' } }), files);
    assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await ranged.text(), '2345');
    const whole = await voiceAudioResponse(new Request(url), files);
    assert.equal(whole.status, 200); assert.equal(await whole.text(), '0123456789');
    assert.equal((await voiceAudioResponse(new Request(url, { headers: { Range: 'bytes=99-' } }), files)).status, 416);
    files.clear(); assert.equal((await voiceAudioResponse(new Request(url), files)).status, 404);
    assert.deepEqual(audioRange('bytes=-4', 10), { start: 6, end: 9 });
    assert.deepEqual(audioRange('bytes=5-', 10), { start: 5, end: 9 });
    for (const range of ['bytes=8-3', 'bytes=-0', 'bytes=0-1,4-5', 'oops']) assert.equal(audioRange(range, 10), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('transcription is owner-scoped, cancellation stops pending resolution, and stale results cannot replace a new job', async () => {
  const file = deferred<string>();
  const commands: unknown[] = [];
  const service = createVoiceDetailService({ resolveAudio: id => id === '1' ? file.promise : Promise.resolve('/fixture.m4a'),
    run: async (command, emit, signal) => {
      commands.push(command); emit({ status: 'transcribing' });
      emit({ segment: { start: 1, end: 2, text: '안녕하세요' } });
      if (!signal.aborted) emit({ status: 'complete' });
    } });
  service.start(1, '1', 'ko_KR', 'first');
  service.cancel(1, 'first'); file.resolve('/old.m4a'); await tick();
  assert.equal(commands.length, 0); assert.equal(service.snapshot(1, 'first').status, 'cancelled');
  service.start(1, '2', 'ko_KR', 'second'); await tick();
  assert.equal(service.snapshot(2, 'second').status, 'cancelled');
  assert.equal(service.snapshot(1, 'second').status, 'complete');
  assert.equal(service.snapshot(1, 'second').segments[0]?.text, '안녕하세요');
  service.cancel(1, 'first'); assert.equal(service.snapshot(1, 'second').status, 'complete');
  service.release(1); assert.equal(service.snapshot(1, 'second').status, 'cancelled');
  assert.throws(() => service.start(1, '2', '../ko', 'third'));
  service.dispose();
});
test('missing files, failed or incomplete helpers are retryable errors and dispose aborts native work', async () => {
  const signals: AbortSignal[] = [];
  let fail = true;
  const service = createVoiceDetailService({ resolveAudio: async () => {
    if (fail) throw new Error('private path'); return '/fixture.m4a';
  }, run: async (_command, _emit, signal) => { signals.push(signal); } });
  service.start(1, '1', 'ko_KR', 'one'); await tick();
  assert.deepEqual(service.snapshot(1, 'one'), { status: 'error', error: 'transcription-failed', segments: [] });
  fail = false; service.start(1, '1', 'ko_KR', 'two'); await tick();
  assert.equal(service.snapshot(1, 'two').status, 'error');
  service.dispose(); assert.equal(signals[0]?.aborted, true);
});
test('native command boundary handles missing executables, aborts, malformed output and timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-speech-process-'));
  try {
    await assert.rejects(runSpeechCommand({}, () => {}, new AbortController().signal, { executable: join(directory, 'missing') }));
    const executable = join(directory, 'helper');
    await writeFile(executable, '#!/bin/sh\nread line\nprintf "not-json\\n"\n', { mode: 0o755 });
    await assert.rejects(runSpeechCommand({}, () => {}, new AbortController().signal, { executable }));
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(runSpeechCommand({}, () => {}, cancelled.signal, { executable }));
    await writeFile(executable, '#!/bin/sh\nread line\nwhile :; do :; done\n', { mode: 0o755 });
    await assert.rejects(runSpeechCommand({}, () => {}, new AbortController().signal, { executable, timeoutMs: 20 }), /timeout/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('speech responses reject invalid values and packaging includes every runtime dependency', async () => {
  assert.equal(speechExecutable('/bundle/Resources', 'file:///bundle/Resources/app.asar/desktop/lib/voice-speech-process.mts'),
    `/bundle/Resources/runtime/${process.platform}-${process.arch}/cheshi-speech`);
  assert.throws(() => voiceCapabilities({ available: 'true', languages: [] }));
  assert.throws(() => voiceTranscription({ status: 'complete', segments: [{ start: -1, end: 1, text: 'bad' }] }));
  const config = await loadForgeConfiguration();
  const ignore = config.packagerConfig!.ignore as (filename: string) => boolean;
  for (const file of ['voice-detail-ipc', 'voice-detail-service', 'voice-audio', 'voice-audio-preparation', 'voice-media-file', 'voice-speech-process', 'voice-recording-file']) {
    assert.equal(ignore(`/desktop/lib/${file}.mts`), false);
  }
  assert.equal(ignore('/desktop/shared/voice-transcription.ts'), false);
});

test('concurrent capability reads share native work and owner release handles cancellation without rejecting IPC', async () => {
  let calls = 0;
  const gate = deferred<void>();
  const expected = { available: true, languages: [{ id: 'ko_KR', name: '한국어', installed: true }] };
  const service = createVoiceDetailService({ platform: 'darwin', resolveAudio: async () => '',
    run: async (_command, emit, signal) => {
      calls++;
      if (calls === 1) await gate.promise;
      else await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      emit(expected);
    } });
  const first = service.capabilities(1), second = service.capabilities(1);
  assert.equal(calls, 1);
  gate.resolve();
  assert.deepEqual(await first, expected); assert.deepEqual(await second, expected);
  const cancelled = service.capabilities(2);
  service.release(2);
  assert.deepEqual(await cancelled, { available: false, languages: [] });
  service.dispose();
});

test('transcription releases prepared audio on both success and failure', async () => {
  let released = 0;
  const paths: string[] = [];
  const service = createVoiceDetailService({ resolveAudio: async () => '/original.qta',
    prepareAudio: async () => ({ path: '/prepared.m4a', release() { released++; } }),
    run: async (command, emit) => {
      paths.push((command as { path: string }).path);
      if (paths.length === 2) throw new Error('failed');
      emit({ status: 'complete' });
    } });
  service.start(1, '1', 'ko_KR', 'one'); await tick();
  service.start(1, '1', 'ko_KR', 'two'); await tick();
  assert.deepEqual(paths, ['/prepared.m4a', '/prepared.m4a']); assert.equal(released, 2);
  service.dispose();
});
