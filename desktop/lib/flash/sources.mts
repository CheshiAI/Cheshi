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
export interface FlashSourceGroup { binding: FlashBinding; sources: FlashSource[] }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const workspaceMemoryAccount = (workspace: string) => digest(['session-workspace-memory-v1', resolve(workspace)]);
// Flash's title field uses Python Unicode code points, not UTF-16 code units.
const FLASH_TITLE_MAX_CHARACTERS = 2000;

export function sessionDocuments(raw: unknown, cwd: string, session: SearchSession): FlashSource[] {
  const record = recordValue(raw);
  const thread = recordValue(record?.thread) ?? record;
  if (thread?.parentThreadId != null || thread?.ephemeral === true) return [];
  const compiled = compileSearchRecord(raw, resolve(cwd), session, Date.now()).thread;
  const title = [...(session.title || 'none')].slice(0, FLASH_TITLE_MAX_CHARACTERS).join('');
  const runningTurns = new Set((Array.isArray(thread?.turns) ? thread.turns : []).flatMap(value => {
    const turn = recordValue(value);
    return turn?.status === 'inProgress' && typeof turn.id === 'string' ? [turn.id] : [];
  }));
  return compiled.entries.flatMap((item, entry) => {
    if ((item.kind !== 'user' && item.kind !== 'assistant') || runningTurns.has(item.turnId)) return [];
    const source_id = digest([compiled.threadId, item.turnId, item.itemId]);
    const content = { threadId: compiled.threadId, turnId: item.turnId, itemId: item.itemId, entry,
      kind: item.kind, text: item.text, title };
    return [{ source_id, revision: digest(['visible-session-sentence-v2', content]), document: { ...content, ordinal: 0 } }];
  });
}

/** Raw history stays in the host; only visible saved user/assistant entries reach Flash. */
export class FlashSources {
  private readonly options: { cwd: string; source: SearchSource };
  private readonly cache = new Map<string, { fingerprint: string; sources: FlashSource[] }>();
  constructor(options: FlashSources['options']) { this.options = options; }
  clear(): void { this.cache.clear(); }

  async sessions(bindings: readonly FlashBinding[]): Promise<SearchSession[]> {
    const profiles = new Set(bindings.map(binding => binding.profileId));
    return searchSessions(await this.options.source.list()).filter(item => profiles.has(item.profileId ?? ''));
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

  async collect(bindings: readonly FlashBinding[], signal: AbortSignal): Promise<FlashSourceGroup[]> {
    const sessions = await this.sessions(bindings);
    const keys = new Set(sessions.map(item => item.sourceKey));
    for (const key of this.cache.keys()) if (!keys.has(key)) this.cache.delete(key);
    const groups = bindings.map(binding => ({ binding, sources: [] as FlashSource[] }));
    const byProfile = new Map(groups.map(group => [group.binding.profileId, group.sources]));
    // Stable initial ordinals; subsequent insertions append without renumbering existing sources.
    for (const session of sessions.sort((a, b) => a.id.localeCompare(b.id))) {
      signal.throwIfAborted();
      byProfile.get(session.profileId!)!.push(...await this.documents(session));
    }
    signal.throwIfAborted();
    return groups;
  }

  async verify(bindings: readonly FlashBinding[], result: unknown, synced: Map<string, FlashSource>): Promise<void> {
    const value = recordValue(result);
    if (!value) throw new FlashError('unavailable', 'Invalid Flash result');
    const turns = Array.isArray(value.turns) ? value.turns : null;
    const excerpts = turns ? turns.flatMap(raw => {
      const turn = recordValue(raw);
      if (!turn || !Array.isArray(turn.messages)) throw new FlashError('unavailable', 'Invalid Flash turn');
      return turn.messages;
    }) : Array.isArray(value.matches) ? value.matches : [value.source, ...(Array.isArray(value.context) ? value.context : [])];
    const ids = new Set(excerpts.flatMap(item => {
      const entry = recordValue(item);
      if (!entry || typeof entry.source_id !== 'string') throw new FlashError('unavailable', 'Invalid Flash source');
      return [entry.source_id, ...(typeof entry.support_source_id === 'string' ? [entry.support_source_id] : [])];
    }));
    const sessions = new Map((await this.sessions(bindings)).map(item => [item.id, item]));
    const current = new Map<string, Map<string, FlashSource>>();
    for (const id of ids) {
      const source = synced.get(id);
      const session = source && sessions.get(source.document.threadId);
      if (!source || !session) throw new FlashError('stale_source', 'Source changed or was deleted. Retry the search.');
      let revisions = current.get(session.id);
      if (!revisions) {
        const originals = await this.documents(session, true);
        revisions = new Map(originals.map(item => [item.source_id, item]));
        current.set(session.id, revisions);
      }
      if (revisions.get(id)?.revision !== source.revision) throw new FlashError('stale_source', 'Source changed. Retry the search.');
    }
    for (const raw of turns ?? []) {
      const turn = recordValue(raw)!;
      const originals = [...(current.get(String(turn.session_id))?.values() ?? [])]
        .filter(item => item.document.turnId === turn.turn_id).sort((a, b) => a.document.entry - b.document.entry);
      const messages = turn.messages as unknown[];
      if (!originals.length || originals.length !== messages.length || originals.some((source, index) => {
        const message = recordValue(messages[index]);
        const doc = source.document;
        return message?.source_id !== source.source_id || message.text !== doc.text || message.kind !== doc.kind
          || message.entry !== doc.entry || message.message_id !== doc.itemId
          || message.session_id !== doc.threadId || message.turn_id !== doc.turnId;
      })) throw new FlashError('stale_source', 'The complete original turn changed. Retry the search.');
    }
  }
}

export async function reconcileSources(connection: FlashConnection, workspace: string, account: string,
  sources: FlashSource[], signal: AbortSignal, progress?: (processed: number, total: number) => void): Promise<Map<string, FlashSource>> {
  const scope = { workspace, account };
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
