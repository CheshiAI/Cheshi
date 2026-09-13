import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatRelayHistory } from '../lib/codex-chat-relay-history.mts';
import { CodexChatRelays } from '../lib/codex-chat-relay.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import { formatChatRelayMessage, type ChatRelayState } from '../shared/chat-relay.ts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';

type Participant = 'a' | 'b';
type JsonObject = Record<string, unknown>;
const participants: Participant[] = ['a', 'b'];
const current = (participant: Participant) => `${participant}-current`;
const locationKey = (profileId: string, threadId: unknown) => `${profileId}:${String(threadId)}`;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected deletion to fail.');
}

function fixture(directory: string, reply: 'complete' | 'fail' = 'complete') {
  const locations = new Map(participants.map(participant => [current(participant), [
    { profileId: 'primary', threadId: `${participant}-root` },
    { profileId: 'secondary', threadId: `${participant}-root` },
    { profileId: 'secondary', threadId: `${participant}-middle` },
    { profileId: 'primary', threadId: `${participant}-middle` },
    { profileId: 'primary', threadId: current(participant) },
  ]]));
  const threads = new Map<string, JsonObject>();
  for (const participant of participants) {
    const peer = participant === 'a' ? 'b' : 'a';
    // Relay provenance links participants in prompt text, independently of the
    // actual fork ancestry created when each conversation changes accounts.
    const preview = formatChatRelayMessage({ relayId: 'isolated-relay', step: 2,
      sourceThreadId: current(peer), role: 'review' }, 'Synthetic relay message.');
    for (const location of locations.get(current(participant))!) {
      threads.set(locationKey(location.profileId, location.threadId), codexThread(location.threadId, {
        cwd: directory, preview,
        forkedFromId: location.threadId.endsWith('-current') ? `${participant}-middle`
          : location.threadId.endsWith('-middle') ? `${participant}-root` : null,
      }));
    }
    threads.set(locationKey('primary', `${participant}-child`), codexThread(`${participant}-child`, {
      cwd: directory, parentThreadId: current(participant), preview: 'Synthetic agent history.',
    }));
  }
  const requests: Array<{ profileId: string; method: string; params: JsonObject }> = [];
  const forgotten: string[] = [];
  const conversations: CodexConversationAccess = {
    async list() { return { sessions: participants.filter(participant => !forgotten.includes(current(participant)))
      .map(participant => threads.get(locationKey('primary', current(participant)))!) }; },
    async resolve(threadId) { return threadId; },
    async locations(threadId) { return locations.get(threadId) ?? []; },
    async forget(threadId) { forgotten.push(threadId); },
    async request(profileId, method, value) {
      const params = value as JsonObject;
      requests.push({ profileId, method, params });
      const owned = [...threads].filter(([key]) => key.startsWith(`${profileId}:`));
      if (method === 'thread/read') {
        const thread = threads.get(locationKey(profileId, params.threadId));
        if (!thread) throw new Error('Synthetic thread missing.');
        return { thread };
      }
      if (method === 'thread/list') return { data: params.archived === true ? []
        : owned.map(([, thread]) => thread).filter(thread => thread.parentThreadId === params.ancestorThreadId), nextCursor: null };
      if (method === 'thread/delete') {
        const deleting = new Set([params.threadId, ...owned.map(([, thread]) => thread)
          .filter(thread => thread.parentThreadId === params.threadId).map(thread => thread.id)]);
        if (owned.some(([, thread]) => !deleting.has(thread.id) && deleting.has(thread.forkedFromId))) {
          const error = new Error(`cannot delete thread ${String(params.threadId)}: forked history still references it`);
          error.name = 'CodexRequestRejectedError';
          throw error;
        }
        if (!threads.has(locationKey(profileId, params.threadId))) throw new Error('Synthetic thread already deleted.');
        for (const threadId of deleting) threads.delete(locationKey(profileId, threadId));
        return {};
      }
      throw new Error(`Unexpected catalog request: ${method}`);
    },
  };
  let turnSequence = 0;
  const events: JsonObject[] = [];
  const createClient = () => {
    const client = createFakeCodexClient({
      'thread/read': (params: JsonObject) => ({ thread: threads.get(locationKey('primary', params.threadId)) }),
      'thread/resume': (params: JsonObject) => ({ thread: threads.get(locationKey('primary', params.threadId)) }),
      'thread/unsubscribe': {},
      'turn/interrupt': {},
      'turn/start': (params: JsonObject) => {
        if (reply === 'fail') throw new Error('Synthetic relay provider failure.');
        const id = `turn-${++turnSequence}`;
        queueMicrotask(() => client.emit('turn/completed', { threadId: params.threadId,
          turn: { id, status: 'completed', items: [{ id: `answer-${id}`, type: 'agentMessage',
            phase: 'final_answer', text: 'Synthetic completed answer.' }] } }));
        return { turn: { id } };
      },
    });
    return { ...client, async stop() {} };
  };
  const serviceOptions = { cwd: directory, conversations, serviceName: 'test', developerInstructions: 'Offline relay deletion test.' };
  const service = new CodexChatService({ ...serviceOptions, client: createClient() });
  const contexts = new CodexChatContexts({ service: serviceOptions, createClient,
    emit(ownerId, event) { events.push({ ...event, ownerId }); } });
  const terminal = createDeferred<ChatRelayState>();
  const history = new CodexChatRelayHistory(join(directory, 'history'));
  const relays = new CodexChatRelays({ contexts, history, emit(_ownerId, state) {
    if (state.status !== 'running' && state.status !== 'stopping') terminal.resolve(state);
  } });
  const panes = { a: contexts.get(1, 'a'), b: contexts.get(1, 'b') };
  for (const participant of participants) panes[participant].viewedThreadId = current(participant);
  const deletion = new CodexChatSessionDeletion({ contexts, service, relays });
  return { service, contexts, relays, panes, threads, requests, forgotten, deletion, events,
    terminal: terminal.promise,
    start: () => relays.start(1, { sourceContextId: 'a', sourceThreadId: current('a'),
      targetContextId: 'b', targetThreadId: current('b'), mode: 'review', maxRounds: 1,
      objective: 'Review isolated synthetic material.' }),
    async close() { await relays.shutdown(); await contexts.stop(); await service.stop(); },
  };
}

describe('deleting one relay participant after account handoffs', () => {
  for (const status of ['stopped', 'error', 'completed'] as const) {
    for (const selected of participants) {
      test(`${status} relay permits deleting only participant ${selected.toUpperCase()} and preserves its peer and relay history`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cheshi-relay-deletion-'));
        const f = fixture(directory, status === 'error' ? 'fail' : 'complete');
        try {
          const started = f.start();
          if (status === 'stopped') f.relays.stop(1);
          expect((await f.terminal).status).toBe(status);
          const saved = await f.relays.listHistory(1);
          expect(saved).toHaveLength(1);
          const historyPath = join(directory, 'history', `${started.id}.json`);
          const historyBefore = await readFile(historyPath, 'utf8');
          const peer = selected === 'a' ? 'b' : 'a';
          const peerBefore = structuredClone([...f.threads].filter(([, thread]) => String(thread.id).startsWith(`${peer}-`)));
          const oldPane = f.contexts.get(2, 'old-copy'); oldPane.viewedThreadId = `${selected}-root`;
          const childPane = f.contexts.get(2, 'agent'); childPane.viewedThreadId = `${selected}-child`;
          childPane.viewedThreadIsSubagent = true;
          f.panes[peer].selectedPermissionModeId = 'full-access';
          const result = await f.deletion.deleteSession(f.panes[selected], current(selected));
          expect(new Set(result.threadIds)).toEqual(new Set([
            `${selected}-root`, `${selected}-middle`, current(selected), `${selected}-child`,
          ]));
          expect(f.requests.filter(request => request.method === 'thread/delete').map(request =>
            locationKey(request.profileId, request.params.threadId))).toEqual([
            `primary:${selected}-current`, `primary:${selected}-middle`, `primary:${selected}-root`,
            `secondary:${selected}-middle`, `secondary:${selected}-root`,
          ]);
          expect([...f.threads]).toEqual(peerBefore);
          expect(f.forgotten).toEqual([current(selected)]);
          expect(f.panes[selected].viewedThreadId).toBeNull();
          expect(oldPane.viewedThreadId).toBeNull();
          expect(childPane.viewedThreadId).toBeNull();
          expect(childPane.viewedThreadIsSubagent).toBe(false);
          expect(f.panes[peer].viewedThreadId).toBe(current(peer));
          expect(f.panes[peer].selectedPermissionModeId).toBe('full-access');
          const peerEvents = f.events.filter(event => event.contextId === peer && event.type === 'sessions-deleted');
          expect(peerEvents).toHaveLength(1);
          expect(peerEvents[0]?.threadIds).toEqual(result.threadIds);
          expect(f.relays.get(1)?.status).toBe(status);
          expect(await f.relays.listHistory(1)).toEqual(saved);
          expect(await readFile(historyPath, 'utf8')).toBe(historyBefore);
          expect(await new CodexChatRelayHistory(join(directory, 'history')).list()).toEqual(saved);
        } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
      });
    }
  }

  for (const status of ['running', 'stopping'] as const) {
    for (const selected of participants) {
      test(`${status} relay blocks participant ${selected.toUpperCase()} deletion before any catalog request`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cheshi-relay-deletion-'));
        const f = fixture(directory);
        try {
          const before = structuredClone([...f.threads]);
          f.start();
          if (status === 'stopping') f.relays.stop(1);
          expect(f.relays.get(1)?.status).toBe(status);
          const operation = f.deletion.deleteSession(f.panes[selected], current(selected));
          f.relays.stop(1);
          expect((await failure(operation)).message).toBe('Stop the conversation relay before deleting this session.');
          await f.terminal;
          expect(f.requests).toHaveLength(0);
          expect(f.forgotten).toHaveLength(0);
          expect([...f.threads]).toEqual(before);
          for (const participant of participants) expect(f.panes[participant].viewedThreadId).toBe(current(participant));
          expect(f.events.some(event => event.type === 'sessions-deleted')).toBe(false);
          expect(await f.relays.listHistory(1)).toHaveLength(1);
        } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
      });
    }
  }
});
