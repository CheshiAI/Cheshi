import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHAT_HISTORY_INDEX_VERSION } from './chat-history-index-store.mts';

export interface SearchDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: (string | number | null)[]): unknown;
    get(...values: (string | number | null)[]): unknown;
    all(...values: (string | number | null)[]): unknown[];
  };
  close(): void;
}

export async function openSearchDatabase(filename: string, cwd: string, readonly = false): Promise<SearchDatabase> {
  if (!readonly) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db: SearchDatabase = process.versions.bun
    ? new (await import('bun:sqlite')).Database(filename, readonly ? { readonly: true } : { create: true })
    : new (await import('node:sqlite')).DatabaseSync(filename, { readOnly: readonly });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if (!readonly) {
      chmodSync(filename, 0o600);
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      const version = db.prepare("SELECT value FROM metadata WHERE key='version'").get() as { value: string } | undefined;
      const schema = `1:${CHAT_HISTORY_INDEX_VERSION}:${cwd}`;
      if (version?.value !== schema) {
        db.exec(`BEGIN IMMEDIATE;
          DROP TABLE IF EXISTS grams; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS threads;
          DELETE FROM metadata;
          CREATE TABLE threads (source_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, fork_id TEXT,
            title TEXT NOT NULL, updated_at REAL NOT NULL, revision TEXT NOT NULL, fingerprint TEXT,
            checked_at REAL NOT NULL);
          CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL REFERENCES threads ON DELETE CASCADE,
            position INTEGER NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL,
            text TEXT NOT NULL, normalized_text TEXT NOT NULL, files TEXT NOT NULL, paths TEXT NOT NULL, hash TEXT NOT NULL,
            UNIQUE(source_key,position));
          CREATE TABLE files (entry_id INTEGER NOT NULL REFERENCES entries ON DELETE CASCADE, path TEXT NOT NULL,
            PRIMARY KEY(path,entry_id));
          CREATE VIRTUAL TABLE grams USING fts5(tokens,content='',contentless_delete=1,detail=none);
          CREATE TRIGGER entries_deleted AFTER DELETE ON entries BEGIN DELETE FROM grams WHERE rowid=old.id; END;`);
        db.prepare('INSERT INTO metadata VALUES(?,?)').run('version', schema);
        db.prepare('INSERT INTO metadata VALUES(?,?)').run('generation', '0');
        db.exec('COMMIT');
      }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
