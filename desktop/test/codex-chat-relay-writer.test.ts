import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatRelays } from '../lib/codex-chat-relay.mts';
import { CodexChatRelayHistory } from '../lib/codex-chat-relay-history.mts';
import type { ChatRelayState } from '../shared/chat-relay.ts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function fixture(path: string) {
  // This RPC double injects exclusive writer ownership independently of turn
  // activity. It exercises Cheshi's real services; it is not a live Codex test.
  const writers = new Map<string, number>();
  const clients: ReturnType<typeof createFakeCodexClient>[] = [];
  const events: Record<string, unknown>[] = [];
  const startedThreads: unknown[] = [];
  const terminalStates = new Map<string, ChatRelayState>();
  const waiting = new Map<string, ReturnType<typeof createDeferred<ChatRelayState>>>();
  let turnSequence = 0;
  let moderatorSequence = 0;
  const contexts = new CodexChatContexts({
    service: { cwd: path, serviceName: 'test', developerInstructions: 'Offline relay verification.' },
    createClient() {
      const clientId = clients.length;
      const acquire = (threadId: string) => {
        const writer = writers.get(threadId);
        if (writer !== undefined && writer !== clientId) {
          throw new Error(`thread ${threadId} already has an active writer`);
        }
        writers.set(threadId, clientId);
        return { thread: codexThread(threadId) };
      };
      const client = createFakeCodexClient({
        'thread/read': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId), {
          status: { type: writers.get(String(params.threadId)) === clientId ? 'idle' : 'notLoaded' },
        }) }),
        'thread/resume': (params: Record<string, unknown>) => acquire(String(params.threadId)),
        'thread/start': () => acquire(`moderator-thread-${++moderatorSequence}`),
        // Removing a subscription need not unload its thread immediately.
        'thread/unsubscribe': {},
        'turn/interrupt': {},
        'turn/start': (params: Record<string, unknown>) => {
          startedThreads.push(params.threadId);
          const id = `turn-${++turnSequence}`;
          queueMicrotask(() => client.emit('turn/completed', { threadId: params.threadId,
            turn: { id, status: 'completed', items: [{ id: `answer-${id}`,
              type: 'agentMessage', phase: 'final_answer', text: `Synthetic answer ${id}` }] } }));
          return { turn: { id } };
        },
      });
      clients.push(client);
      return { ...client, async stop() {
        for (const [threadId, owner] of writers) if (owner === clientId) writers.delete(threadId);
      } };
    },
    emit(ownerId, event) { events.push({ ...event, ownerId }); },
  });
  const history = new CodexChatRelayHistory(join(path, 'history'));
  const relays = new CodexChatRelays({ contexts, history, emit(_ownerId, state) {
    if (state.status === 'running' || state.status === 'stopping') return;
    terminalStates.set(state.id, state);
    waiting.get(state.id)?.resolve(state);
    waiting.delete(state.id);
  } });
  const otherWriter = contexts.get(2, 'other-pane');
  await otherWriter.openSession('source-thread');
  await otherWriter.ensureWritableThread();
  await contexts.get(1, 'source').openSession('source-thread');
  await contexts.get(1, 'target').openSession('target-thread');
  return { contexts, relays, otherWriter, clients, events, writers, startedThreads,
    request: { sourceContextId: 'source', sourceThreadId: 'source-thread',
      targetContextId: 'target', targetThreadId: 'target-thread', objective: 'Compare synthetic implementation plans.' },
    terminal(id: string): Promise<ChatRelayState> {
      const state = terminalStates.get(id);
      if (state) return Promise.resolve(state);
      const deferred = createDeferred<ChatRelayState>();
      waiting.set(id, deferred);
      return deferred.promise;
    },
    requests(method: string) { return clients.flatMap(client => client.requests.filter(request => request.method === method)); },
  };
}

describe('relay failure when an idle thread has another writer', () => {
  for (const scenario of [
    { mode: 'review', maxRounds: 1, phase: 'proposal', outcome: 'reviewed', steps: 3 },
    { mode: 'debate', maxRounds: 3, phase: 'discussion', outcome: 'debated', steps: 7 },
  ] as const) {
    test(`${scenario.mode} records A's first resume failure and completes after the other writer releases`, async () => {
      const path = await mkdtemp(join(tmpdir(), 'cheshi-relay-writer-'));
      const f = await fixture(path);
      try {
        const source = f.contexts.get(1, 'source');
        const target = f.contexts.get(1, 'target');
        expect(f.otherWriter.activeTurns.size).toBe(0);
        expect(f.otherWriter.pendingTurnStarts.size).toBe(0);
        expect(source.activeTurns.size).toBe(0);
        expect(source.subscribedThreadIds.has('source-thread')).toBe(false);
        expect(f.writers.has('source-thread')).toBe(true);
        const request = { ...f.request, mode: scenario.mode, maxRounds: scenario.maxRounds };
        const started = f.relays.start(1, request);
        expect(started.status).toBe('running');
        const failed = await f.terminal(started.id);
        const message = 'thread source-thread already has an active writer';
        expect(failed).toMatchObject({ status: 'error', mode: scenario.mode,
          maxRounds: scenario.maxRounds, step: 1, round: 1, speaker: 'A',
          phase: scenario.phase, outcome: null, summary: null, message });
        expect(f.requests('turn/start')).toHaveLength(0);
        expect(f.requests('turn/interrupt')).toHaveLength(0);
        expect(f.clients[1]!.requests.filter(request => request.method === 'thread/resume'))
          .toEqual([{ method: 'thread/resume', params: expect.objectContaining({ threadId: 'source-thread' }) }]);
        expect(f.clients[2]!.requests.some(request => request.method === 'thread/resume')).toBe(false);
        expect(f.events.filter(event => event.type === 'user-message'))
          .toEqual([expect.objectContaining({ ownerId: 1, contextId: 'source', threadId: 'source-thread' })]);
        const records = await f.relays.listHistory(1);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ id: started.id, objective: f.request.objective, state: failed });
        expect(records[0]?.finishedAt).not.toBeNull();
        expect((await new CodexChatRelayHistory(join(path, 'history')).list())[0]).toEqual(records[0]);
        if (scenario.mode === 'debate') {
          expect(failed.moderatorThreadId).toBe('moderator-thread-1');
          expect(f.contexts.existing(1, failed.moderatorContextId!)).toBeNull();
          expect(f.writers.has('moderator-thread-1')).toBe(false);
        }
        for (const [contextId, service] of [['source', source], ['target', target]] as const) {
          expect(service.activeTurns.size).toBe(0);
          expect(service.pendingTurnStarts.size).toBe(0);
          expect(await f.relays.mutation(1, contextId, () => service.viewedThreadId)).toBe(`${contextId}-thread`);
        }
        expect(source.subscribedThreadIds.has('source-thread')).toBe(false);
        expect(f.otherWriter.subscribedThreadIds.has('source-thread')).toBe(true);
        await f.otherWriter.newSession();
        expect(f.writers.has('source-thread')).toBe(true);
        await f.contexts.dispose(2, 'other-pane');
        expect(f.writers.has('source-thread')).toBe(false);
        const retry = f.relays.start(1, request);
        expect(retry.id).not.toBe(started.id);
        const completed = await f.terminal(retry.id);
        expect(completed).toMatchObject({ status: 'completed', step: scenario.steps,
          mode: scenario.mode, outcome: scenario.outcome });
        expect(f.startedThreads).toEqual(scenario.mode === 'review'
          ? ['source-thread', 'target-thread', 'source-thread']
          : ['source-thread', 'target-thread', 'source-thread', 'target-thread', 'source-thread', 'target-thread', 'moderator-thread-2']);
        const saved = await f.relays.listHistory(1);
        expect(saved).toHaveLength(2);
        expect(saved.find(record => record.id === started.id)?.state).toEqual(failed);
        expect(saved.find(record => record.id === retry.id)?.state).toEqual(completed);
      } finally {
        await f.relays.shutdown();
        await f.contexts.stop();
        await rm(path, { recursive: true, force: true });
      }
    });
  }
});
