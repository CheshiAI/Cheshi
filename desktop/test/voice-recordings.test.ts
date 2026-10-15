import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createVoiceRecordingsService, readVoiceMemoDatabase, voiceMemoDatabasePaths } from '../lib/voice-recordings-service.mts';
import { registerVoiceRecordingsIpc } from '../lib/voice-recordings-ipc.mts';
import { voiceRecordingsSnapshot, VOICE_RECORDINGS_CHANNEL, VOICE_RECORDINGS_SETTINGS_CHANNEL } from '../shared/voice-recordings.ts';
import { loadForgeConfiguration } from './forge-test-helpers.ts';

async function withDatabase(run: (db: DatabaseSync, filename: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-voice-recordings-'));
  const filename = join(directory, 'CloudRecordings.db');
  const db = new DatabaseSync(filename);
  try { await run(db, filename); }
  finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}
const empty = { status: 'ready', recordings: [], truncated: false } as const;

test('reads live WAL metadata in date order, prefers display title and excludes deleted recordings without altering data', async () => {
  await withDatabase(async (db, filename) => {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE ZCLOUDRECORDING(Z_PK INTEGER PRIMARY KEY, ZDATE REAL, ZDURATION REAL, ZENCRYPTEDTITLE TEXT, ZCUSTOMLABEL TEXT, ZMARKEDFORDELETION INTEGER);
      INSERT INTO ZCLOUDRECORDING VALUES(1,100,817,'엘에스로116번길','date label',0),(2,200,65,NULL,'Second',0),(3,300,40,'Deleted',NULL,1);`);
    const before = await readFile(filename);
    const wal = await readFile(`${filename}-wal`);
    const snapshot = readVoiceMemoDatabase(filename);
    assert.deepEqual(snapshot.recordings, [
      { id: '2', title: 'Second', recordedAt: 978307400000, durationSeconds: 65 },
      { id: '1', title: '엘에스로116번길', recordedAt: 978307300000, durationSeconds: 817 },
    ]);
    assert.deepEqual(await readFile(filename), before);
    assert.deepEqual(await readFile(`${filename}-wal`), wal);
    db.exec("UPDATE ZCLOUDRECORDING SET ZENCRYPTEDTITLE='Renamed' WHERE Z_PK=1");
    assert.equal(readVoiceMemoDatabase(filename).recordings[1]?.title, 'Renamed');
  });
});

test('supports older titles, missing metadata and explicit deletion dates', async () => {
  await withDatabase(async (db, filename) => {
    db.exec(`CREATE TABLE ZCLOUDRECORDING(Z_PK INTEGER PRIMARY KEY,ZDATE REAL,ZDURATION REAL,ZCUSTOMLABEL TEXT,ZDELETIONDATE REAL);
      INSERT INTO ZCLOUDRECORDING VALUES(1,NULL,-1,'',NULL),(2,100,30,'Deleted',42);`);
    assert.deepEqual(readVoiceMemoDatabase(filename).recordings, [{ id: '1', title: 'Untitled recording', recordedAt: null, durationSeconds: null }]);
  });
});

test('bounds large lists and explicitly reports truncation', async () => {
  await withDatabase(async (db, filename) => {
    db.exec(`CREATE TABLE ZCLOUDRECORDING(Z_PK INTEGER PRIMARY KEY,ZDATE REAL,ZDURATION REAL,ZCUSTOMLABEL TEXT);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO ZCLOUDRECORDING SELECT x,x,1,'Memo' FROM n;`);
    const result = readVoiceMemoDatabase(filename);
    assert.equal(result.recordings.length, 10000);
    assert.equal(result.recordings[0]?.id, '10001');
    assert.equal(result.truncated, true);
    assert.deepEqual(voiceRecordingsSnapshot(result), result);
  });
});

test('distinguishes denied, missing, unsupported and temporarily unavailable libraries; permits retry', async () => {
  let denied = true, probes = 0;
  const service = createVoiceRecordingsService({ platform: 'darwin', home: '/fixture',
    probe: async () => { probes++; if (denied) throw Object.assign(new Error('Denied'), { code: 'EPERM' }); },
    read: () => ({ ...empty, recordings: [] }) });
  assert.equal((await service.list()).status, 'permission-required');
  assert.equal(probes, 1);
  denied = false;
  assert.equal((await service.list()).status, 'ready');
  assert.equal((await createVoiceRecordingsService({ platform: 'linux', probe: async () => assert.fail('Do not probe') }).list()).status, 'unsupported');
  assert.equal((await createVoiceRecordingsService({ platform: 'darwin', probe: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }).list()).status, 'ready');
  assert.equal((await createVoiceRecordingsService({ platform: 'darwin', probe: async () => {}, read: () => { throw new Error('database is locked'); } }).list()).status, 'unavailable');
});

test('falls back only for absent libraries and reports unknown schema', async () => {
  const seen: string[] = [];
  const paths = voiceMemoDatabasePaths('/fixture');
  const service = createVoiceRecordingsService({ platform: 'darwin', home: '/fixture',
    probe: async filename => { seen.push(filename); if (filename === paths[0]) throw Object.assign(new Error(), { code: 'ENOENT' }); },
    read: () => ({ ...empty, recordings: [] }) });
  assert.equal((await service.list()).status, 'ready');
  assert.deepEqual(seen, paths.slice(0, 2));
  await withDatabase(async (_db, filename) => {
    const unsupported = createVoiceRecordingsService({ platform: 'darwin', probe: async () => {}, read: () => readVoiceMemoDatabase(filename) });
    assert.equal((await unsupported.list()).status, 'unsupported-format');
  });
});

test('response boundary rejects malformed values, duplicate ids and contradictory error states', () => {
  const recording = { id: '1', title: 'Memo', recordedAt: 0, durationSeconds: 1 };
  for (const value of [{ ...empty, truncated: 'true' }, { ...empty, recordings: [recording, recording] },
    { ...empty, recordings: [{ ...recording, durationSeconds: -1 }] },
    { ...empty, recordings: [{ ...recording, recordedAt: Infinity }] },
    { ...empty, status: 'permission-required', recordings: [recording] }]) {
    assert.throws(() => voiceRecordingsSnapshot(value), TypeError);
  }
});

test('IPC validates sender before reading and accepts no file path from the renderer', async () => {
  let handler: Parameters<IpcMain['handle']>[1] | undefined;
  let allowed = false, reads = 0;
  registerVoiceRecordingsIpc({ ipcMain: { handle: (channel, fn) => { if (channel === VOICE_RECORDINGS_CHANNEL) handler = fn; } },
    openExternal: async () => { assert.fail('Listing must not open settings'); },
    assertSender: () => { if (!allowed) throw new Error('Unauthorized'); },
    service: { list: async () => { reads++; return { ...empty, recordings: [] }; } } });
  const event = {} as IpcMainInvokeEvent;
  assert.throws(() => handler!(event), /Unauthorized/);
  assert.equal(reads, 0);
  allowed = true;
  assert.deepEqual(await handler!(event, '/unrelated/path'), empty);
  assert.equal(reads, 1);
});

test('settings IPC checks sender and platform and opens only the fixed Full Disk Access destination', async () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  let allowed = false, failOpen = false;
  const urls: string[] = [];
  const options = { ipcMain: { handle: (channel: string, fn: Parameters<IpcMain['handle']>[1]) => { handlers.set(channel, fn); } },
    assertSender: () => { if (!allowed) throw new Error('Unauthorized'); },
    service: { list: async () => ({ ...empty, recordings: [] }) },
    openExternal: async (url: string) => { urls.push(url); if (failOpen) throw new Error('Launch failed'); } };
  registerVoiceRecordingsIpc({ ...options, platform: 'darwin' });
  const event = {} as IpcMainInvokeEvent;
  const open = () => handlers.get(VOICE_RECORDINGS_SETTINGS_CHANNEL)!(event, 'https://untrusted.example');
  await assert.rejects(async () => open(), /Unauthorized/);
  assert.equal(urls.length, 0);
  allowed = true;
  assert.equal(await open(), true);
  assert.deepEqual(urls, ['x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles']);
  failOpen = true;
  assert.equal(await open(), false);
  registerVoiceRecordingsIpc({ ...options, platform: 'linux' });
  assert.equal(await open(), false);
  assert.equal(urls.length, 2);
});

test('packaging includes the service, IPC and shared contract', async () => {
  const { packagerConfig } = await loadForgeConfiguration();
  const ignore = packagerConfig.ignore as (path: string) => boolean;
  for (const path of ['/desktop/lib/voice-recordings-service.mts', '/desktop/lib/voice-recordings-ipc.mts', '/desktop/shared/voice-recordings.ts']) {
    assert.equal(ignore(path), false, path);
  }
});
