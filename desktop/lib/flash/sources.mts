import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { compileSearchRecord, historyFingerprint, searchSessions, type SearchSession, type SearchSource } from '../chat-search-source.mts';
import { recordValue } from '../codex-service-utils.mts';
import { callFlash, FlashError, type FlashConnection } from './client.mts';

export interface FlashDocument {
  threadId: string; turnId: string; itemId: string; entry: number; ordinal: number;
  kind: 'user' | 'assistant'; text: string; title: string;
}
export interface FlashSource { source_id: string; revision: string; document: FlashDocument }
export interface StoredSource { source_id: string; revision: string; ordinal: number; session_id: string }
export interface FlashBinding { profileId: string; account: string }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function sessionDocuments(raw: unknown, cwd: string, session: SearchSession): FlashSource[] {
  const record = recordValue(raw);
  const thread = recordValue(record?.thread) ?? record;
  if (thread?.parentThreadId != null || thread?.ephemeral === true) return [];
  const compiled = compileSearchRecord(raw, resolve(cwd), session, Date.now()).thread;
  const runningTurns = new Set((Array.isArray(thread?.turns) ? thread.turns : []).flatMap(value => {
    const turn = recordValue(value);
    return turn?.status === 'inProgress' && typeof turn.id === 'string' ? [turn.id] : [];
  }));
  return compiled.entries.flatMap((item, entry) => {
    if ((item.kind !== 'user' && item.kind !== 'assistant') || runningTurns.has(item.turnId)) return [];
    const source_id = digest([compiled.threadId, item.turnId, item.itemId]);
    const content = { threadId: compiled.threadId, turnId: item.turnId, itemId: item.itemId, entry,
      kind: item.kind, text: item.text, title: session.title || 'none' };
    return [{ source_id, revision: digest(['frozen-session-v1', content]), document: { ...content, ordinal: 0 } }];
  });
}

/** Raw history stays in the host; only visible saved user/assistant entries reach Flash. */
export class FlashSources {
  private readonly options: { cwd: string; source: SearchSource };
  private readonly cache = new Map<string, { fingerprint: string; sources: FlashSource[] }>();
  constructor(options: FlashSources['options']) { this.options = options; }
  clear(): void { this.cache.clear(); }

  async sessions(binding: FlashBinding): Promise<SearchSession[]> {
    return searchSessions(await this.options.source.list()).filter(item => item.profileId === binding.profileId);
  }

  async documents(session: SearchSession, fresh = false): Promise<FlashSource[]> {
    const fingerprint = await historyFingerprint(session);
    const key = JSON.stringify([session.revision, fingerprint]);
    const cached = this.cache.get(session.sourceKey);
    if (!fresh && fingerprint !== null && cached?.fingerprint === key) return cached.sources;
    const sources = sessionDocuments(await this.options.source.read(session.id, session.profileId), this.options.cwd, session);
    // Do not cache a moving file snapshot.
    if (fingerprint !== null && fingerprint === await historyFingerprint(session)) {
      this.cache.set(session.sourceKey, { fingerprint: key, sources });
    }
    return sources;
  }

  async collect(binding: FlashBinding, signal: AbortSignal): Promise<FlashSource[]> {
    const sessions = await this.sessions(binding);
    const keys = new Set(sessions.map(item => item.sourceKey));
    for (const key of this.cache.keys()) if (!keys.has(key)) this.cache.delete(key);
    const sources: FlashSource[] = [];
    // Stable initial ordinals; subsequent insertions append without renumbering existing sources.
    for (const session of sessions.sort((a, b) => a.id.localeCompare(b.id))) {
      signal.throwIfAborted();
      sources.push(...await this.documents(session));
    }
    signal.throwIfAborted();
    return sources;
  }

  async verify(binding: FlashBinding, result: unknown, synced: Map<string, FlashSource>): Promise<void> {
    const value = recordValue(result);
    if (!value) throw new FlashError('unavailable', 'Invalid Flash result');
    const excerpts = Array.isArray(value.matches) ? value.matches : [value.source, ...(Array.isArray(value.context) ? value.context : [])];
    const ids = new Set(excerpts.flatMap(item => {
      const entry = recordValue(item);
      if (!entry || typeof entry.source_id !== 'string') throw new FlashError('unavailable', 'Invalid Flash source');
      return [entry.source_id, ...(typeof entry.support_source_id === 'string' ? [entry.support_source_id] : [])];
    }));
    const sessions = new Map((await this.sessions(binding)).map(item => [item.id, item]));
    const current = new Map<string, Map<string, string>>();
    for (const id of ids) {
      const source = synced.get(id);
      const session = source && sessions.get(source.document.threadId);
      if (!source || !session) throw new FlashError('stale_source', 'Source changed or was deleted. Retry the search.');
      let revisions = current.get(session.id);
      if (!revisions) {
        revisions = new Map((await this.documents(session, true)).map(item => [item.source_id, item.revision]));
        current.set(session.id, revisions);
      }
      if (revisions.get(id) !== source.revision) throw new FlashError('stale_source', 'Source changed. Retry the search.');
    }
  }
}

export async function reconcileSources(connection: FlashConnection, workspace: string, binding: FlashBinding,
  sources: FlashSource[], signal: AbortSignal, progress?: (processed: number, total: number) => void): Promise<Map<string, FlashSource>> {
  const scope = { workspace, account: binding.account };
  const admin = <T = { generation: number },>(method: string, params: Record<string, unknown>) => callFlash<T>(connection, method, { ...scope, ...params }, signal);
  let { generation } = await callFlash<{ generation: number }>(connection, 'status', {}, signal);
  ({ generation } = await admin('scope.enable', { expected_generation: generation }));
  const stored = new Map<string, StoredSource>();
  let after: string | null = '';
  while (after !== null) {
    const page: { sources: StoredSource[]; next: string | null } = await admin('sources.list', { after, expected_generation: generation });
    for (const source of page.sources) stored.set(source.source_id, source);
    if (page.next !== null && page.next <= after) throw new FlashError('unavailable', 'Invalid Flash source cursor');
    after = page.next;
  }
  let ordinal = [...stored.values()].reduce((max, item) => Math.max(max, item.ordinal + 1), 0);
  const present = new Set(sources.map(item => item.source_id));
  // Remove old data before ingesting additions; an interrupted sync is never published by the host.
  for (const source_id of stored.keys()) {
    if (!present.has(source_id)) ({ generation } = await admin('source.delete', { source_id, expected_generation: generation }));
  }
  let processed = sources.filter(source => source.revision === stored.get(source.source_id)?.revision).length;
  progress?.(processed, sources.length);
  for (const source of sources) {
    signal.throwIfAborted();
    const old = stored.get(source.source_id);
    source.document.ordinal = old?.ordinal ?? ordinal++;
    if (source.revision === old?.revision) continue;
    ({ generation } = await admin('source.ingest', { ...source, expected_revision: old?.revision ?? null, expected_generation: generation }));
    progress?.(++processed, sources.length);
  }
  await admin('sync.complete', { cursor: digest(sources.map(item => [item.source_id, item.revision])), expected_generation: generation });
  return new Map(sources.map(item => [item.source_id, item]));
}
