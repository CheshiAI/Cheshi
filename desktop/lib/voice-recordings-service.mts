import { resolveVoiceRecordingFile, assertRecordingId } from './voice-recording-file.mts';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { VOICE_RECORDINGS_LIMIT, type VoiceRecording, type VoiceRecordingsSnapshot } from '../shared/voice-recordings.ts';

const APPLE_EPOCH_MS = 978307200000;
const TITLE_COLUMNS = ['ZENCRYPTEDTITLE', 'ZCUSTOMLABEL', 'ZCUSTOMLABELFORSORTING'] as const;
const DELETION_COLUMNS = ['ZMARKEDFORDELETION', 'ZDELETIONDATE', 'ZTRASHEDDATE'] as const;
class UnsupportedVoiceMemoSchema extends Error {}

export function voiceMemoDatabasePaths(home: string): string[] {
  return [
    'Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings',
    'Library/Application Support/com.apple.voicememos/Recordings',
    'Library/Containers/com.apple.VoiceMemos/Data/Library/Application Support/Recordings',
  ].map(directory => join(home, directory, 'CloudRecordings.db'));
}

function assertSupportedSchema(columns: Set<string>): void {
  if (!['Z_PK', 'ZDATE', 'ZDURATION'].every(name => columns.has(name)) || !TITLE_COLUMNS.some(name => columns.has(name))) {
    throw new UnsupportedVoiceMemoSchema('Unrecognized Voice Memos database.');
  }
}

/** Reads Apple's existing database, including its WAL, without copying or changing journal settings. */
export function readVoiceMemoDatabase(filename: string): VoiceRecordingsSnapshot {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(ZCLOUDRECORDING)').all().map(row => String(row.name)));
    assertSupportedSchema(columns);
    const titles = TITLE_COLUMNS.filter(name => columns.has(name));
    const deleted = DELETION_COLUMNS.filter(name => columns.has(name));
    // All SQL identifiers come from fixed allowlists; no renderer input reaches the query.
    const rows = db.prepare(`SELECT Z_PK, ZDATE, ZDURATION, ${titles.join(', ')} FROM ZCLOUDRECORDING
      ${deleted.length ? `WHERE ${deleted.map(name => `COALESCE(${name}, 0) = 0`).join(' AND ')}` : ''}
      ORDER BY ZDATE DESC, Z_PK DESC LIMIT ?`).all(VOICE_RECORDINGS_LIMIT + 1);
    const recordings = rows.slice(0, VOICE_RECORDINGS_LIMIT).map((row): VoiceRecording => {
      const title = titles.map(name => row[name]).find(value => typeof value === 'string' && value.trim());
      const date = typeof row.ZDATE === 'number' ? row.ZDATE * 1000 + APPLE_EPOCH_MS : NaN;
      return { id: String(row.Z_PK), title: typeof title === 'string' ? title.trim().slice(0, 4096) : 'Untitled recording',
        recordedAt: Number.isFinite(date) && Math.abs(date) <= 8.64e15 ? date : null,
        durationSeconds: typeof row.ZDURATION === 'number' && Number.isFinite(row.ZDURATION) && row.ZDURATION >= 0 ? row.ZDURATION : null };
    });
    return { status: 'ready', recordings, truncated: rows.length > VOICE_RECORDINGS_LIMIT };
  } finally { db.close(); }
}

interface Options {
  platform?: string;
  home?: string;
  probe?: (filename: string) => Promise<void>;
  read?: (filename: string) => VoiceRecordingsSnapshot;
}
export function createVoiceRecordingsService(options: Options = {}) {
  const platform = options.platform ?? process.platform;
  const paths = voiceMemoDatabasePaths(options.home ?? homedir());
  const probe = options.probe ?? (async (filename: string) => { const handle = await open(filename, 'r'); await handle.close(); });
  const read = options.read ?? readVoiceMemoDatabase;
  const empty = (status: VoiceRecordingsSnapshot['status']): VoiceRecordingsSnapshot => ({ status, recordings: [], truncated: false });
  let pending: Promise<VoiceRecordingsSnapshot> | undefined;
  const load = async (): Promise<VoiceRecordingsSnapshot> => {
    if (platform !== 'darwin') return empty('unsupported');
    for (const filename of paths) {
      try { await probe(filename); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        return empty(code === 'EPERM' || code === 'EACCES' ? 'permission-required' : 'unavailable');
      }
      try { return read(filename); }
      catch (error) {
        if (error instanceof UnsupportedVoiceMemoSchema) return empty('unsupported-format');
        const detail = error as NodeJS.ErrnoException & { errcode?: number };
        const denied = detail.code === 'EPERM' || detail.code === 'EACCES' || detail.errcode === 23 || detail.errcode === 3
          || (error instanceof Error && /authorization denied|permission denied|operation not permitted/i.test(error.message));
        return empty(denied ? 'permission-required' : 'unavailable');
      }
    }
    return empty('ready');
  };
  return { async resolveAudio(id: string): Promise<string> {
    assertRecordingId(id);
    if (platform !== 'darwin') throw new Error('Voice Memos requires macOS.');
    for (const filename of paths) {
      try { await probe(filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      return resolveVoiceRecordingFile(filename, id);
    }
    throw new Error('Recording unavailable.');
  }, list(): Promise<VoiceRecordingsSnapshot> {
    pending ??= load().finally(() => { pending = undefined; });
    return pending;
  } };
}
