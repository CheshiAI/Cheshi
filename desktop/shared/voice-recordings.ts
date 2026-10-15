import type { VoiceDetailApi } from './voice-transcription.ts';
export const VOICE_RECORDINGS_CHANNEL = 'cheshi:voice-recordings:list';
export const VOICE_RECORDINGS_SETTINGS_CHANNEL = 'cheshi:voice-recordings:open-full-disk-access';
export const VOICE_RECORDINGS_LIMIT = 10_000;
export interface VoiceRecording {
  id: string;
  title: string;
  recordedAt: number | null;
  durationSeconds: number | null;
}
export type VoiceRecordingsStatus = 'ready' | 'permission-required' | 'unsupported' | 'unsupported-format' | 'unavailable';
export interface VoiceRecordingsSnapshot {
  status: VoiceRecordingsStatus;
  recordings: VoiceRecording[];
  truncated: boolean;
}
export interface VoiceRecordingsApi {
  detail?: VoiceDetailApi;
  list(): Promise<VoiceRecordingsSnapshot>;
  openFullDiskAccessSettings?(): Promise<boolean>;
}

export function voiceRecordingsSnapshot(value: unknown): VoiceRecordingsSnapshot {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid recordings response.');
  const record = value as Record<string, unknown>;
  const statuses: readonly unknown[] = ['ready', 'permission-required', 'unsupported', 'unsupported-format', 'unavailable'];
  if (!statuses.includes(record.status) || !Array.isArray(record.recordings)
    || record.recordings.length > VOICE_RECORDINGS_LIMIT || (record.truncated !== true && record.truncated !== false)) {
    throw new TypeError('Invalid recordings response.');
  }
  const ids = new Set<string>();
  const recordings = record.recordings.map((item: unknown): VoiceRecording => {
    if (!item || typeof item !== 'object') throw new TypeError('Invalid recording.');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || row.id.length > 256 || ids.has(row.id)
      || typeof row.title !== 'string' || !row.title || row.title.length > 4096
      || (row.recordedAt !== null && (typeof row.recordedAt !== 'number' || !Number.isFinite(row.recordedAt) || Math.abs(row.recordedAt) > 8.64e15))
      || (row.durationSeconds !== null && (typeof row.durationSeconds !== 'number' || !Number.isFinite(row.durationSeconds) || row.durationSeconds < 0))) {
      throw new TypeError('Invalid recording.');
    }
    ids.add(row.id);
    return { id: row.id, title: row.title, recordedAt: row.recordedAt as number | null, durationSeconds: row.durationSeconds as number | null };
  });
  if (record.status !== 'ready' && (recordings.length || record.truncated)) throw new TypeError('Invalid recordings failure.');
  return { status: record.status as VoiceRecordingsStatus, recordings, truncated: record.truncated };
}
