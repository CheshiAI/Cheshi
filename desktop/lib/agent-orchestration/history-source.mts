import { createHash } from 'node:crypto';
import type { CollaborationConnection } from './service.mts';
import { recordValue } from '../codex-service-utils.mts';
import { searchSessions, compileSearchRecord } from '../chat-search-source.mts';
import { ChatHistoryRecall } from '../chat-history-recall.mts';
import type { RecallEvaluator } from '../chat-history-recall-model.mts';
import type { ChatHistoryIndexRecord } from '../chat-history-index-store.mts';

export type HistoryRoute = '/history/exchange' | '/history/catalog' | '/history/read';
export type HistoryTransport = (connection: CollaborationConnection, route: HistoryRoute, body: unknown, signal: AbortSignal) => Promise<unknown>;
export const requestWorkerHistory: HistoryTransport = async (connection, route, body, signal) => {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('History requires a published loopback worker endpoint.');
  }
  const response = await fetch(new URL(route, url), { method: 'POST', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Worker history is unavailable. Start the agent to update its worker.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) throw new Error('Worker history exceeds the response limit.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); }
};
const fingerprint = (record: ChatHistoryIndexRecord) => createHash('sha256').update(JSON.stringify([record.title, record.thread])).digest('hex');
export type HistoryProof = Record<string, string>;
export function createAgentHistory(connection: CollaborationConnection, evaluate: RecallEvaluator, transport: HistoryTransport = requestWorkerHistory) {
  const observed = new Map<string, ChatHistoryIndexRecord>();
  const readRecords = async (threadIds?: string[], signal: AbortSignal = new AbortController().signal) => {
    const sessions = searchSessions(await transport(connection, '/history/catalog', {}, signal));
    if (sessions.length > 10_000) throw new Error('Worker history catalog is too large.');
    const selected = threadIds ? sessions.filter(s => threadIds.includes(s.id)) : sessions;
    const unavailableSessions = threadIds?.filter(id => !sessions.some(s => s.id === id)) ?? [];
    const records: ChatHistoryIndexRecord[] = [];
    for (const session of selected) {
      signal.throwIfAborted();
      try {
        const raw = await transport(connection, '/history/read', { threadId: session.id }, signal);
        const record = compileSearchRecord(raw, '/workspace', session, Date.now());
        records.push(record); observed.set(session.id, record);
      } catch { signal.throwIfAborted(); observed.delete(session.id); unavailableSessions.push(session.id); }
    }
    return { records, unavailableSessions };
  };
  const recall = new ChatHistoryRecall({ history: { readRecords }, evaluate });
  return {
    async call(tool: string, value: unknown, threadId: string, signal: AbortSignal) {
      const args = recordValue(value);
      if (!args) throw new Error('Invalid history arguments.');
      const allowed = tool === 'history_search' ? ['query', 'scope', 'focusThreadId', 'afterOrdinal', 'offset', 'snapshot'] : ['threadId', 'turnId', 'itemId', 'offset'];
      if (Object.keys(args).some(k => !allowed.includes(k))) throw new Error('Unsupported history argument.');
      const sessions = searchSessions(await transport(connection, '/history/catalog', {}, signal));
      if (!sessions.some(s => s.id === threadId)) throw new Error('Current conversation is outside this agent’s scope.');
      const target = tool === 'history_read' ? args.threadId : args.focusThreadId;
      if (target !== undefined && !sessions.some(s => s.id === target)) throw new Error('Requested conversation is outside this agent’s scope.');
      const result = tool === 'history_search' ? await recall.search({ ...args, threadId }, signal)
        : tool === 'history_read' ? await recall.read(args, signal) : null;
      if (!result) throw new Error('Unknown history tool.');
      const proof: HistoryProof = {};
      // Include every returned source, including neighbors and citation-followed originals.
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        const object = recordValue(value);
        if (!object) return;
        if (typeof object.threadId === 'string' && observed.has(object.threadId)) proof[object.threadId] = fingerprint(observed.get(object.threadId)!);
        Object.values(object).forEach(visit);
      };
      visit(result);
      return { result: { ...result, sourceScope: 'this-agent-project-account',
        projection: 'Authored user text and assistant messages; generated envelopes, instructions and tool output omitted.' }, proof };
    },
    async verify(proof: HistoryProof, signal: AbortSignal) {
      const ids = Object.keys(proof);
      if (!ids.length) return true;
      const fresh = await readRecords(ids, signal);
      return !fresh.unavailableSessions.length && fresh.records.length === ids.length
        && fresh.records.every(r => fingerprint(r) === proof[r.thread.threadId]);
    },
  };
}
