import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SummaryInput } from '../lib/flash/summary.mts';
import type { FlashDocument } from '../lib/flash/sources.mts';
import type { FlashHost } from '../lib/flash/runtime.mts';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';

export async function fixtureSummary(input: SummaryInput) {
  const messages = input.turns.flatMap(turn => turn.messages);
  return { summary: messages.map(item => item.text).join('\n'), insufficient_evidence: false,
    evidence: messages.map(item => ({ source_id: item.source_id, quote: item.text })) };
}
export const readRequest = (session_id = 's', turn_id = 'turn') => ({ question: 'What was decided?', turns: [{ session_id, turn_id }] });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export async function rejection(operation: () => Promise<unknown>): Promise<Error> {
  try { await operation(); } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected failure');
}
export function account(activeId = 'a', authenticated = true): CodexAccountsSnapshot {
  return { activeId, profiles: [{ id: activeId, label: activeId, email: `${activeId}@example.com`,
    login: { state: 'signed_in', error: null },
    usage: { state: 'ready', authenticated, plan: null, rateLimits: [], error: null } }] };
}
export const session = (id = 's', profileId = 'a') => ({ id, profileId, title: 'Session', updatedAt: 10, status: 'idle' });
export function history(text = 'A saved decision about local memory.', id = 's') {
  return { thread: { id, cwd: '/workspace', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'message', type: 'agentMessage', text },
  ] }] } };
}

/** A wire-level fixture: production authorization is tested by Flash's own Python suite. */
export async function flashFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'flash-test-'));
  const socketPath = join(directory, 'flash.sock');
  const sockets = new Set<Socket>();
  const stored = new Map<string, Map<string, { revision: string; document: FlashDocument }>>();
  const grants = new Map<string, string>();
  const methods: string[] = [];
  let generation = 0;
  let serial: Promise<unknown> = Promise.resolve();
  let beforeSearch: (() => Promise<void>) | undefined;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer);
      void (async () => {
        const { method, params: p, token } = request;
        methods.push(method);
        const scope = JSON.stringify([p.workspace, p.account]);
        const scopeSources = stored.get(scope) ?? new Map();
        let result: unknown;
        if (method === 'status') result = { generation, state: 'ready' };
        else if (method === 'scope.enable') { stored.set(scope, scopeSources); result = { generation }; }
        else if (method === 'sources.list') result = { sources: [...scopeSources].map(([source_id, item]) => ({
          source_id, revision: item.revision, ordinal: item.document.ordinal, session_id: item.document.threadId,
        })), next: null };
        else if (method === 'source.ingest') { scopeSources.set(p.source_id, { revision: p.revision, document: p.document }); result = { generation: ++generation }; }
        else if (method === 'source.delete') { scopeSources.delete(p.source_id); result = { generation: ++generation }; }
        else if (method === 'sessions.delete') {
          for (const [key, sources] of stored) if (JSON.parse(key)[0] === p.workspace) {
            for (const [id, item] of sources) if (p.session_ids.includes(item.document.threadId)) sources.delete(id);
          }
          result = { generation: ++generation };
        }
        else if (method === 'sync.complete') result = { generation };
        else if (method === 'grant.create') { grants.set(p.homie, scope); result = { token: p.homie }; }
        else if (method === 'grant.revoke') { grants.delete(p.homie); result = { revoked: true }; }
        else if (method === 'memory_search' || method === 'memory_read_turns') {
          await beforeSearch?.();
          const docs = stored.get(grants.get(token) ?? '') ?? new Map();
          const matches = [...docs].filter(([, item]) => !p.session_id || item.document.threadId === p.session_id)
            .map(([source_id, item]) => ({ source_id, session_id: item.document.threadId, turn_id: item.document.turnId,
              message_id: item.document.itemId, kind: item.document.kind, entry: item.document.entry,
              text: item.document.text, offset: 0, next_offset: null, total_characters: [...item.document.text].length }));
          result = method === 'memory_search' ? { matches } : { turns: p.turns.map((ref: { session_id: string; turn_id: string }) => ({
            ...ref, messages: matches.filter(item => item.session_id === ref.session_id && item.turn_id === ref.turn_id).sort((a, b) => a.entry - b.entry),
          })) };
        } else throw new Error('Unexpected fixture request');
        if (!socket.destroyed) socket.end(JSON.stringify({ version: 1, id: request.id, result }) + '\n');
      })().catch(() => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const host: FlashHost = {
    transaction: (operation, signal) => {
      const next = serial.then(() => { signal.throwIfAborted(); return operation({ socketPath, token: 'admin' }); });
      serial = next.catch(() => {}); return next;
    }, release: async () => {},
  };
  return { host, socketPath, methods, stored, grants, searchHook: (hook: () => Promise<void>) => { beforeSearch = hook; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    } };
}
