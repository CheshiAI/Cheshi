import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SearchDatabase } from './chat-search-database.mts';
import { indexedGrams, normalizeSearchText, queryGrams } from './chat-search-grams.mts';
import type { AppleNotesFolder, AppleNoteSummary } from '../shared/apple-notes.ts';
import type { NotesSearchRequest, NotesSearchHit } from '../shared/apple-notes-search.ts';

export interface IndexedNote extends AppleNoteSummary { folderId: string; bodyReady: boolean }
export class NotesSearchStore {
  private readonly db: SearchDatabase;
  constructor(db: SearchDatabase) { this.db = db; }
  static async open(filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const db: SearchDatabase = process.versions.bun
      ? new (await import('bun:sqlite')).Database(filename, { create: true })
      : new (await import('node:sqlite')).DatabaseSync(filename);
    try {
      chmodSync(filename, 0o600);
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT OR IGNORE INTO meta VALUES('version','0');
        CREATE TABLE IF NOT EXISTS notes(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, folder_id TEXT NOT NULL,
          summary TEXT NOT NULL, body TEXT NOT NULL, title_normal TEXT NOT NULL, body_normal TEXT NOT NULL, body_ready INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS grams USING fts5(tokens,content='',contentless_delete=1,detail=none);
        CREATE TRIGGER IF NOT EXISTS notes_deleted AFTER DELETE ON notes BEGIN DELETE FROM grams WHERE rowid=old.rowid; END;`);
      return new NotesSearchStore(db);
    } catch (error) { db.close(); throw error; }
  }
  private change(run: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { run(); this.db.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='version'; COMMIT"); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  catalog(): { notes: IndexedNote[]; ready: boolean } {
    return { ready: !!this.db.prepare("SELECT value FROM meta WHERE key='ready'").get(),
      notes: (this.db.prepare('SELECT summary,folder_id,body_ready FROM notes').all() as { summary: string; folder_id: string; body_ready: number }[])
        .map(row => ({ ...JSON.parse(row.summary), folderId: row.folder_id, bodyReady: row.body_ready === 1 })) };
  }
  put(folderId: string, note: AppleNoteSummary & { plaintext?: string }, bodyReady: boolean) {
    // Locked notes retain searchable titles, never plaintext from an earlier unlocked revision.
    const body = note.locked ? '' : note.plaintext ?? '';
    const title = normalizeSearchText(note.title), normalized = normalizeSearchText(body);
    const { id, title: name, modifiedAt, createdAt, locked } = note;
    this.change(() => {
      this.db.prepare('DELETE FROM notes WHERE id=?').run(id);
      this.db.prepare('INSERT INTO notes(id,folder_id,summary,body,title_normal,body_normal,body_ready) VALUES(?,?,?,?,?,?,?)')
        .run(id, folderId, JSON.stringify({ id, title: name, modifiedAt, createdAt, locked }), body.normalize('NFC'), title, normalized, bodyReady ? 1 : 0);
      const row = this.db.prepare('SELECT rowid FROM notes WHERE id=?').get(id) as { rowid: number };
      this.db.prepare('INSERT INTO grams(rowid,tokens) VALUES(?,?)').run(row.rowid, indexedGrams([title, normalized]));
    });
  }
  remove(ids: string[]) {
    if (!ids.length) return;
    this.change(() => { const remove = this.db.prepare('DELETE FROM notes WHERE id=?'); for (const id of ids) remove.run(id); });
  }
  clear() { this.change(() => { this.db.exec("DELETE FROM notes; DELETE FROM meta WHERE key='ready';"); }); }
  complete(folders: AppleNotesFolder[]) {
    const value = JSON.stringify(folders);
    const old = this.db.prepare("SELECT value FROM meta WHERE key='ready'").get() as { value: string } | undefined;
    if (old?.value !== value) this.change(() => { this.db.prepare("INSERT OR REPLACE INTO meta VALUES('ready',?)").run(value); });
  }
  query(request: NotesSearchRequest) {
    const version = (this.db.prepare("SELECT value FROM meta WHERE key='version'").get() as { value: string }).value;
    if (request.offset && request.version !== version) throw new Error('Search results changed. Search again to continue.');
    const terms = normalizeSearchText(request.query.trim()).split(/\s+/u).filter(Boolean);
    const stored = this.db.prepare("SELECT value FROM meta WHERE key='ready'").get() as { value: string } | undefined;
    const folders = stored ? JSON.parse(stored.value) as AppleNotesFolder[] : [];
    if (!terms.length) return { hits: [], total: 0, nextOffset: null, version, folders };
    const where = `rowid IN (SELECT rowid FROM grams WHERE grams MATCH ?) AND ${terms.map(() => '(instr(title_normal,?)>0 OR instr(body_normal,?)>0)').join(' AND ')}`;
    const params = [queryGrams(terms), ...terms.flatMap(term => [term, term])];
    const total = (this.db.prepare(`SELECT count(*) AS count FROM notes WHERE ${where}`).get(...params) as { count: number }).count;
    const offset = request.offset ?? 0;
    const rows = this.db.prepare(`SELECT summary,folder_id,body,title_normal FROM notes WHERE ${where} ORDER BY json_extract(summary,'$.modifiedAt') DESC,id LIMIT 100 OFFSET ?`)
      .all(...params, offset) as { summary: string; folder_id: string; body: string; title_normal: string }[];
    const hits: NotesSearchHit[] = rows.map(row => {
      const note = JSON.parse(row.summary) as AppleNoteSummary;
      const term = terms.find(term => !row.title_normal.includes(term) && normalizeSearchText(row.body).includes(term));
      const position = term ? normalizeSearchText(row.body).indexOf(term) : -1;
      const start = Math.max(0, position - 60);
      return { ...note, folderId: row.folder_id, ...(position < 0 ? {} : {
        snippet: `${start ? '…' : ''}${row.body.slice(start, start + 240).replace(/\s+/gu, ' ')}${row.body.length > start + 240 ? '…' : ''}`,
      }) };
    });
    return { hits, folders, total, nextOffset: offset + hits.length < total ? offset + hits.length : null, version };
  }
  close() { this.db.close(); }
}
