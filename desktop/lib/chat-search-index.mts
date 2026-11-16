import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ChatHistoryIndexRecord } from './chat-history-index-store.mts';
import type { SearchDatabase } from './chat-search-database.mts';
import { indexedGrams, normalizeSearchText } from './chat-search-grams.mts';

export interface IndexedSession {
  source_key: string; thread_id: string; revision: string; fingerprint: string | null; checked_at: number;
}

/** Only the writer worker owns mutations. A whole conversation changes atomically. */
export class ChatSearchIndex {
  private readonly db: SearchDatabase;
  constructor(db: SearchDatabase) { this.db = db; }

  sessions(): IndexedSession[] {
    return this.db.prepare('SELECT source_key,thread_id,revision,fingerprint,checked_at FROM threads').all() as IndexedSession[];
  }

  private transaction(operation: () => boolean): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (operation()) this.db.exec("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='generation'");
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  put(record: ChatHistoryIndexRecord, fingerprint: string | null): void {
    this.transaction(() => {
      const oldThread = this.db.prepare('SELECT thread_id,fork_id,title,updated_at FROM threads WHERE source_key=?').get(record.sourceKey) as
        { thread_id: string; fork_id: string | null; title: string; updated_at: number } | undefined;
      let changed = !oldThread || oldThread.thread_id !== record.thread.threadId || oldThread.fork_id !== record.thread.forkedFromId
        || oldThread.title !== record.title || oldThread.updated_at !== record.updatedAt;
      this.db.prepare(`INSERT INTO threads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET
        thread_id=excluded.thread_id,fork_id=excluded.fork_id,title=excluded.title,updated_at=excluded.updated_at,
        revision=excluded.revision,fingerprint=excluded.fingerprint,checked_at=excluded.checked_at`)
        .run(record.sourceKey, record.thread.threadId, record.thread.forkedFromId, record.title, record.updatedAt,
          record.revision, fingerprint, record.checkedAt);
      const previous = this.db.prepare('SELECT id,position,hash FROM entries WHERE source_key=?').all(record.sourceKey) as
        Array<{ id: number; position: number; hash: string }>;
      const byPosition = new Map(previous.map(entry => [entry.position, entry]));
      if (previous.length !== record.thread.entries.length) changed = true;
      const insert = this.db.prepare(`INSERT INTO entries(source_key,position,turn_id,item_id,kind,text,normalized_text,files,paths,hash)
        VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`);
      const insertGrams = this.db.prepare('INSERT INTO grams(rowid,tokens) VALUES(?,?)');
      const insertFile = this.db.prepare('INSERT OR IGNORE INTO files VALUES(?,?)');
      record.thread.entries.forEach((entry, position) => {
        const hash = createHash('sha256').update(JSON.stringify([entry.turnId, entry.itemId, entry.kind, entry.text, entry.files])).digest('hex');
        const old = byPosition.get(position);
        if (old?.hash === hash) return;
        changed = true;
        if (old) this.db.prepare('DELETE FROM entries WHERE id=?').run(old.id);
        const text = normalizeSearchText(entry.text);
        const paths = entry.files.flatMap(file => [file.path, `./${file.path}`, resolve(record.cwd, file.path)]).map(normalizeSearchText);
        const row = insert.get(record.sourceKey, position, entry.turnId, entry.itemId, entry.kind, entry.text,
          text, JSON.stringify(entry.files), JSON.stringify(paths), hash) as { id: number };
        insertGrams.run(row.id, indexedGrams([text, ...paths]));
        for (const file of entry.files) insertFile.run(row.id, file.path);
      });
      this.db.prepare('DELETE FROM entries WHERE source_key=? AND position>=?').run(record.sourceKey, record.thread.entries.length);
      return changed;
    });
  }

  remove(sourceKeys: readonly string[]): void {
    if (!sourceKeys.length) return;
    this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM threads WHERE source_key=?');
      let changed = false;
      for (const key of sourceKeys) {
        const result = remove.run(key) as { changes: number | bigint };
        if (Number(result.changes)) changed = true;
      }
      return changed;
    });
  }
}
