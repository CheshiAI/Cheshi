import { randomUUID } from 'node:crypto';
import type { SearchDatabase } from './chat-search-database.mts';
import { normalizeSearchText, queryGrams } from './chat-search-grams.mts';
import { searchLineage, searchSnippet } from './chat-history-search-pages.mts';
import type { chatHistorySearchRequest, ChatHistorySearchHit, ChatHistorySearchResponse } from '../shared/chat-history-search.ts';

type Request = ReturnType<typeof chatHistorySearchRequest>;
interface Match { id: number; duplicateCount: number }
interface Snapshot { key: string; generation: string; createdAt: number; terms: string[]; matches: Match[]; indexedSessions: number }
interface Candidate { id: number; source_key: string; thread_id: string; hash: string; position: number; updated_at: number }
const termsFor = (query: string) => normalizeSearchText(query).split(/\s+/u).filter(Boolean);
const requestKey = (request: Request) => JSON.stringify([termsFor(request.query), request.filePath, request.limit]);
const expired = () => new Error('Search results have expired or changed. Refresh the search to continue.');

/** Snapshots contain row ids, never all matched message bodies. */
export class ChatSearchQuery {
  private readonly db: SearchDatabase;
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(db: SearchDatabase) { this.db = db; }

  search(request: Request, now: number): ChatHistorySearchResponse {
    this.db.exec('BEGIN');
    try {
      const result = this.read(request, now);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private read(request: Request, now: number): ChatHistorySearchResponse {
    const generation = (this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get() as { value: string }).value;
    for (const [id, snapshot] of this.snapshots) {
      if (now < snapshot.createdAt || now - snapshot.createdAt >= 300_000 || snapshot.generation !== generation) this.snapshots.delete(id);
    }
    if (request.refresh) this.snapshots.clear();
    let id: string;
    let snapshot: Snapshot;
    let offset = 0;
    if (request.cursor) {
      const [cursorId, position, extra] = request.cursor.split(':');
      offset = Number(position);
      const found = this.snapshots.get(cursorId!);
      if (!found || extra !== undefined || !/^\d+$/.test(position ?? '') || !Number.isSafeInteger(offset)
        || offset <= 0 || offset >= found.matches.length || found.key !== requestKey(request)) throw expired();
      id = cursorId!; snapshot = found;
    } else {
      id = randomUUID();
      snapshot = this.find(request, generation, now);
      if (snapshot.matches.length > request.limit) this.snapshots.set(id, snapshot);
      while (this.snapshots.size > 3) this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    const end = Math.min(offset + request.limit, snapshot.matches.length);
    const get = this.db.prepare(`SELECT e.turn_id AS turnId,e.item_id AS itemId,e.kind,e.text,e.files,
      t.thread_id AS threadId,t.title,t.updated_at AS updatedAt FROM entries e JOIN threads t USING(source_key) WHERE e.id=?`);
    const hits = snapshot.matches.slice(offset, end).map(match => {
      const { text, files, ...hit } = get.get(match.id) as Omit<ChatHistorySearchHit, 'snippet' | 'duplicateCount' | 'files'> & { text: string; files: string };
      return { ...hit, snippet: searchSnippet(text, snapshot.terms), files: JSON.parse(files), duplicateCount: match.duplicateCount };
    });
    return { hits, total: snapshot.matches.length, indexedSessions: snapshot.indexedSessions, unavailableSessions: [],
      ...(end < snapshot.matches.length ? { nextCursor: `${id}:${end}` } : {}) };
  }

  private find(request: Request, generation: string, now: number): Snapshot {
    const terms = termsFor(request.query);
    const conditions: string[] = [];
    const values: string[] = [];
    if (terms.length) {
      conditions.push('e.id IN (SELECT rowid FROM grams WHERE grams MATCH ?)');
      values.push(queryGrams(terms));
    }
    if (request.filePath) {
      conditions.push('e.id IN (SELECT entry_id FROM files WHERE path=?)'); values.push(request.filePath);
    }
    // Gram intersections are candidates: verify contiguous matches within each original field.
    for (const term of terms) {
      conditions.push('(instr(e.normalized_text,?)>0 OR EXISTS(SELECT 1 FROM json_each(e.paths) WHERE instr(value,?)>0))');
      values.push(term, term);
    }
    const candidates = this.db.prepare(`SELECT e.id,e.source_key,e.hash,e.position,t.thread_id,t.updated_at
      FROM entries e JOIN threads t USING(source_key) WHERE ${conditions.join(' AND ')}`).all(...values) as Candidate[];
    candidates.sort((a, b) => b.updated_at - a.updated_at || a.source_key.localeCompare(b.source_key) || a.position - b.position);
    const threads = this.db.prepare('SELECT thread_id,fork_id FROM threads').all() as Array<{ thread_id: string; fork_id: string | null }>;
    const parents = new Map(threads.map(thread => [thread.thread_id, thread.fork_id]));
    const roots = new Map(threads.map(thread => [thread.thread_id, searchLineage(thread.thread_id, parents)]));
    const matches = new Map<string, Match>();
    for (const candidate of candidates) {
      const identity = JSON.stringify([roots.get(candidate.thread_id), candidate.hash]);
      const existing = matches.get(identity);
      if (existing) existing.duplicateCount++;
      else matches.set(identity, { id: candidate.id, duplicateCount: 0 });
    }
    return { key: requestKey(request), generation, createdAt: now, terms, matches: [...matches.values()], indexedSessions: threads.length };
  }
}
