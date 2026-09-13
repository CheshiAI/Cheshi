import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { compileChatHistoryThread, normalizeChatHistoryFilePath } from './chat-history-compiler.mts';
import { CHAT_HISTORY_INDEX_VERSION, ChatHistoryIndexStore, type ChatHistoryIndexRecord } from './chat-history-index-store.mts';
import { chatHistorySearchRequest } from '../shared/chat-history-search.ts';
import type { ChatHistorySearchHit, ChatHistorySearchResponse } from '../shared/chat-history-search.ts';
import { recordValue } from './codex-service-utils.mts';

interface SessionSource {
  list(): Promise<{ sessions: unknown[] }>;
  read(threadId: string, profileId?: string): Promise<unknown>;
}

interface SearchSession { id: string; profileId?: string; title: string; updatedAt: number; sourceKey: string; revision: string; active: boolean }
interface HistorySearchOptions { directory: string; cwd: string; source: SessionSource; now?(): number }
const REVALIDATE_AFTER_MS = 30_000;
const normalizeText = (text: string) => text.normalize('NFC').toLowerCase();

function sessionsFromSource(value: unknown): SearchSession[] {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.sessions)) throw new Error('The session search catalog is unavailable.');
  const sessions = new Map<string, SearchSession>();
  for (const value of response.sessions) {
    const session = recordValue(value);
    if (!session || typeof session.id !== 'string' || !session.id || typeof session.title !== 'string'
      || typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)
      || (session.profileId !== undefined && (typeof session.profileId !== 'string' || !session.profileId))) {
      throw new Error('The session search catalog contains an invalid session.');
    }
    const sourceKey = JSON.stringify([session.profileId ?? '', session.id]);
    sessions.set(sourceKey, {
      id: session.id, profileId: session.profileId as string | undefined, title: session.title, updatedAt: session.updatedAt, sourceKey,
      revision: JSON.stringify([session.updatedAt, session.title, session.preview, session.status]),
      active: session.status === 'active' || session.status === 'inProgress',
    });
  }
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.sourceKey.localeCompare(b.sourceKey));
}

function snippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const normalized = normalizeText(flat);
  const match = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, (match.length ? Math.min(...match) : 0) - 60);
  return `${start ? '…' : ''}${flat.slice(start, start + 260)}${flat.length > start + 260 ? '…' : ''}`;
}

function lineage(threadId: string, parents: Map<string, string | null>): string {
  const seen = new Set<string>();
  let current = threadId;
  while (parents.get(current) && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current)!;
  }
  // Malformed cycles must not collapse independent conversations.
  return seen.has(current) ? threadId : current;
}

function findHits(records: ChatHistoryIndexRecord[], query: string, filePath: string, limit: number): Pick<ChatHistorySearchResponse, 'hits' | 'total'> {
  const terms = normalizeText(query).split(/\s+/u).filter(Boolean);
  const parents = new Map(records.map(record => [record.thread.threadId, record.thread.forkedFromId]));
  const hits = new Map<string, ChatHistorySearchHit>();
  for (const record of records) {
    for (const entry of record.thread.entries) {
      if (filePath && !entry.files.some(file => file.path === filePath)) continue;
      // File aliases let one free-text query match paths without interpreting prose as a file filter.
      const searchable = [entry.text, ...entry.files.flatMap(file => [file.path, `./${file.path}`, resolve(record.cwd, file.path)])]
        .map(normalizeText);
      if (!terms.every(term => searchable.some(value => value.includes(term)))) continue;
      const identity = createHash('sha256').update(JSON.stringify([
        lineage(record.thread.threadId, parents), entry.turnId, entry.itemId, entry.kind, entry.text, entry.files,
      ])).digest('hex');
      const existing = hits.get(identity);
      if (existing) { existing.duplicateCount += 1; continue; }
      hits.set(identity, {
        threadId: record.thread.threadId, turnId: entry.turnId, itemId: entry.itemId,
        title: record.title, snippet: snippet(entry.text, terms), kind: entry.kind,
        updatedAt: record.updatedAt, files: entry.files, duplicateCount: 0,
      });
    }
  }
  return { hits: [...hits.values()].slice(0, limit), total: hits.size };
}

/** Indexes persisted parent conversations using read-only history requests, never model calls. */
export class ChatHistorySearch {
  private readonly options: HistorySearchOptions;
  private readonly store: ChatHistoryIndexStore;
  private readonly cwd: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly deletedIds = new Set<string>();
  private stopped = false;

  constructor(options: HistorySearchOptions) {
    this.options = options;
    this.cwd = resolve(options.cwd);
    this.store = new ChatHistoryIndexStore(options.directory);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  search(value: unknown): Promise<ChatHistorySearchResponse> {
    const request = chatHistorySearchRequest(value);
    const filePath = request.filePath ? normalizeChatHistoryFilePath(request.filePath, this.cwd) : '';
    if (request.filePath && !filePath) throw new TypeError('Choose a file within the current workspace.');
    return this.enqueue(async () => {
      if (this.stopped) throw new Error('Session search is closed.');
      const sessions = sessionsFromSource(await this.options.source.list()).filter(session => !this.deletedIds.has(session.id));
      await this.store.retain(sessions.map(session => session.sourceKey));
      const records: ChatHistoryIndexRecord[] = [];
      const unavailableSessions: string[] = [];
      const now = this.options.now?.() ?? Date.now();
      for (const session of sessions) {
        if (this.stopped) throw new Error('Session search is closed.');
        if (this.deletedIds.has(session.id)) continue;
        let record = await this.store.load(session.sourceKey, this.cwd);
        if (!record || request.refresh || session.active || record.revision !== session.revision
          || now < record.checkedAt || now - record.checkedAt >= REVALIDATE_AFTER_MS) {
          try {
            const raw = await this.options.source.read(session.id, session.profileId);
            assertSearchThread(raw, this.cwd);
            record = {
              version: CHAT_HISTORY_INDEX_VERSION, cwd: this.cwd, sourceKey: session.sourceKey, revision: session.revision,
              checkedAt: now, title: session.title, updatedAt: session.updatedAt,
              thread: compileChatHistoryThread(raw, this.cwd),
            };
            assertExpectedThread(record, session.id);
          } catch {
            // Never return stale matches after an inaccessible or malformed history read.
            unavailableSessions.push(session.id);
            await this.store.remove(session.sourceKey);
            continue;
          }
          if (this.deletedIds.has(session.id)) continue;
          await this.store.save(record);
        }
        if (!this.deletedIds.has(session.id)) records.push(record);
      }
      const available = records.filter(record => !this.deletedIds.has(record.thread.threadId));
      return { ...findHits(available, request.query, filePath || '', request.limit),
        indexedSessions: available.length, unavailableSessions: unavailableSessions.filter(id => !this.deletedIds.has(id)) };
    });
  }

  /** Mark immediately so an in-flight refresh cannot resurrect a deleted session. */
  remove(threadIds: readonly string[]): Promise<void> {
    for (const id of threadIds) this.deletedIds.add(id);
    return this.enqueue(() => this.store.removeThreads(this.deletedIds));
  }

  stop(): Promise<void> { this.stopped = true; return this.queue; }
}

function assertExpectedThread(record: ChatHistoryIndexRecord, expectedId: string): void {
  if (record.thread.threadId !== expectedId) throw new Error('The session search history changed during indexing. Retry the search.');
}

function assertSearchThread(value: unknown, cwd: string): void {
  const response = recordValue(value);
  const thread = recordValue(response?.thread) ?? response;
  if (!thread || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd) || resolve(thread.cwd) !== cwd
    || thread.parentThreadId != null || thread.ephemeral === true) {
    throw new Error('Only saved parent conversations in the current workspace can be indexed.');
  }
}
