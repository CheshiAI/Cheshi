export type LocalHistoryReason = 'opened' | 'saved' | 'external' | 'before-restore' | 'restored';

export interface LocalHistoryEntry {
  id: string;
  path: string;
  createdAt: number;
  reason: LocalHistoryReason;
  size: number;
}

export interface LocalHistorySnapshot {
  entry: LocalHistoryEntry;
  content: string;
  hasBom: boolean;
  lineEnding: 'lf' | 'crlf' | 'cr';
}

export interface LocalHistoryRestoreRequest {
  path: string;
  id: string;
  expectedRevision: string;
}

export const LOCAL_HISTORY_RETENTION_DAYS = 30;
export const LOCAL_HISTORY_MAX_BYTES = 100 * 1024 * 1024;
