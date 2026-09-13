import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexChatRelayHistory } from '../lib/codex-chat-relay-history.mts';
import { CodexChatRelays } from '../lib/codex-chat-relay.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import type { ChatRelayHistoryRecord, ChatRelayState } from '../shared/chat-relay.ts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';
import type { IpcMainInvokeEvent } from 'electron';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';
import { CodexChatSavedTurns } from '../lib/codex-chat-saved-turns.mts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function expectFailure(operation: Promise<unknown>, message: string) {
  try { await operation; }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error('Expected the operation to reject.');
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'cheshi-relay-history-'));
  directories.push(path);
  return path;
}

function record(id = 'relay-a', status: ChatRelayState['status'] = 'completed'): ChatRelayHistoryRecord {
  const timestamp = '2026-09-08T01:00:00.000Z';
  return { id, objective: 'Compare approaches.', startedAt: timestamp, updatedAt: timestamp,
    finishedAt: status === 'running' || status === 'stopping' ? null : timestamp,
    state: { id, mode: 'review', maxRounds: 1, status, step: 3, round: 1, speaker: 'A', phase: 'revision',
      sourceContextId: 'source', sourceThreadId: 'source-thread', targetContextId: 'target', targetThreadId: 'target-thread',
      outcome: status === 'completed' ? 'reviewed' : null, proposalVersion: null,
      proposal: 'Final proposal', summary: 'Final summary', issues: [], message: null } };
}

describe('conversation history archive', () => {
  test('persists complete results, clones inputs, and orders concurrent snapshots', async () => {
    const path = await directory();
    const history = new CodexChatRelayHistory(path);
    const first = record();
    const firstWrite = history.save(first);
    first.state.proposal = 'Mutation after save';
    await firstWrite;
    expect((await history.list())[0]?.state.proposal).toBe('Final proposal');
    const next = record();
    next.state.summary = 'Latest summary';
    await Promise.all([history.save(record()), history.save(next)]);
    await history.flush();
    expect((await new CodexChatRelayHistory(path).list())[0]?.state.summary).toBe('Latest summary');
    expect(await readdir(path)).toEqual(['relay-a.json']);
  });

  test('recovers unfinished runs once without restarting or stopping current live writes', async () => {
    const path = await directory();
    await writeFile(join(path, 'relay-a.json'), JSON.stringify(record('relay-a', 'running')));
    await writeFile(join(path, 'relay-b.json'), JSON.stringify(record('relay-b', 'stopping')));
    const history = new CodexChatRelayHistory(path);
    const recovered = await history.list();
    expect(recovered).toHaveLength(2);
    for (const value of recovered) {
      expect(value.state).toMatchObject({ status: 'stopped', outcome: null, proposal: 'Final proposal' });
      expect(value.finishedAt).not.toBeNull();
      expect(JSON.parse(await readFile(join(path, `${value.id}.json`), 'utf8')).state.status).toBe('stopped');
    }
    await history.save(record('relay-live', 'running'));
    expect((await history.list()).find((value) => value.id === 'relay-live')?.state.status).toBe('running');
  });

  test('validates the archive before recovery and never replaces malformed JSON', async () => {
    const path = await directory();
    const pendingSource = JSON.stringify(record('relay-a', 'running'));
    await writeFile(join(path, 'relay-a.json'), pendingSource);
    await writeFile(join(path, 'broken.json'), '{invalid');
    const history = new CodexChatRelayHistory(path);
    await expectFailure(history.list(), 'preserved');
    await expectFailure(history.save(record()), 'preserved');
    expect(await readFile(join(path, 'broken.json'), 'utf8')).toBe('{invalid');
    expect(await readFile(join(path, 'relay-a.json'), 'utf8')).toBe(pendingSource);
  });

  test('rejects malformed records, mismatched filenames, and path traversal', async () => {
    const path = await directory();
    const history = new CodexChatRelayHistory(path);
    expect(() => history.save(record('../outside'))).toThrow('Invalid conversation history');
    await writeFile(join(path, 'relay-a.json'), JSON.stringify(record('other-id')));
    await expectFailure(history.list(), 'Invalid conversation history');
  });

  test('retries initialization after a corrupt record is repaired externally', async () => {
    const path = await directory();
    await writeFile(join(path, 'relay-a.json'), '{invalid');
    const history = new CodexChatRelayHistory(path);
    await expectFailure(history.list(), 'preserved');
    await writeFile(join(path, 'relay-a.json'), JSON.stringify(record()));
    expect((await history.list())[0]?.id).toBe('relay-a');
    await history.save(record('relay-b'));
    expect((await history.list()).map((value) => value.id)).toEqual(['relay-a', 'relay-b']);
  });

  test('keeps recovery timestamps valid when the clock is earlier than the saved update', async () => {
    const path = await directory();
    const pending = record('relay-a', 'running');
    pending.startedAt = pending.updatedAt = '9999-01-01T00:00:00.000Z';
    await writeFile(join(path, 'relay-a.json'), JSON.stringify(pending));
    const history = new CodexChatRelayHistory(path);
    const recovered = (await history.list())[0];
    expect(recovered).toMatchObject({ startedAt: pending.startedAt, updatedAt: pending.updatedAt,
      finishedAt: pending.updatedAt, state: { status: 'stopped', outcome: null } });
    expect((await new CodexChatRelayHistory(path).list())[0]).toEqual(recovered);
  });

  test('preserves a record corrupted after initialization and permits independent records', async () => {
    const path = await directory();
    const history = new CodexChatRelayHistory(path);
    await history.save(record());
    await writeFile(join(path, 'relay-a.json'), '{}');
    await expectFailure(history.save(record()), 'preserved');
    expect(await readFile(join(path, 'relay-a.json'), 'utf8')).toBe('{}');
    await history.save(record('relay-b'));
    expect(JSON.parse(await readFile(join(path, 'relay-b.json'), 'utf8')).id).toBe('relay-b');
  });

  test('separates workspace archives and sorts newest first', async () => {
    const first = new CodexChatRelayHistory(join(await directory(), 'history'));
    const second = new CodexChatRelayHistory(join(await directory(), 'history'));
    const latest = record('latest');
    latest.startedAt = latest.updatedAt = latest.finishedAt = '2026-09-08T02:00:00.000Z';
    await first.save(record());
    await first.save(latest);
    expect((await first.list()).map((value) => value.id)).toEqual(['latest', 'relay-a']);
    expect(await second.list()).toEqual([]);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function relayFixture(history: CodexChatRelayHistory) {
  const completed = createDeferred<ChatRelayState>();
  const failure = createDeferred<ChatRelayState>();
  let sequence = 0;
  const contexts = new CodexChatContexts({
    service: { cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test instructions.' },
    createClient() {
      const client = createFakeCodexClient({
        'thread/read': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
        'thread/resume': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
        'thread/start': () => ({ thread: codexThread('moderator-thread') }),
        'thread/unsubscribe': {}, 'turn/interrupt': {},
        'turn/start': (params: Record<string, unknown>) => {
          const id = `turn-${++sequence}`;
          queueMicrotask(() => client.emit('turn/completed', { threadId: params.threadId,
            turn: { id, status: 'completed', items: [{ id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Answer ${id}` }] } }));
          return { turn: { id } };
        },
      });
      return { ...client, async stop() {} };
    }, emit() {},
  });
  const relays = new CodexChatRelays({ contexts, history, emit(_owner, state) {
    if (state.status === 'completed') completed.resolve(state);
    if (state.historyError) failure.resolve(state);
  } });
  await contexts.get(1, 'source').openSession('source-thread');
  await contexts.get(1, 'target').openSession('target-thread');
  const request = { sourceContextId: 'source', sourceThreadId: 'source-thread', targetContextId: 'target', targetThreadId: 'target-thread', objective: 'Compare approaches.' };
  return { contexts, relays, completed: completed.promise, failure: failure.promise, request };
}

describe('relay history integration', () => {
  test('keeps the independent moderator thread and synthesis after its context is disposed', async () => {
    const path = await directory();
    const f = await relayFixture(new CodexChatRelayHistory(path));
    try {
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1 });
      const completed = await f.completed;
      expect(completed).toMatchObject({ speaker: 'C', phase: 'synthesis', moderatorThreadId: 'moderator-thread' });
      expect(f.contexts.existing(1, completed.moderatorContextId!)).toBeNull();
      await f.relays.shutdown();
      const records = await new CodexChatRelayHistory(path).list();
      expect(records[0]?.state).toMatchObject({ status: 'completed', speaker: 'C', phase: 'synthesis', outcome: 'debated',
        moderatorContextId: completed.moderatorContextId, moderatorThreadId: 'moderator-thread', summary: 'Answer turn-3' });
    } finally { await f.contexts.stop(); }
  });

  test('shutdown stops the relay, drains writes, and rejects subsequent starts', async () => {
    const path = await directory();
    const f = await relayFixture(new CodexChatRelayHistory(path));
    try {
      f.relays.start(1, f.request);
      await f.relays.shutdown();
      const records = await new CodexChatRelayHistory(path).list();
      expect(records[0]?.state).toMatchObject({ status: 'stopped', outcome: null });
      expect(records[0]?.finishedAt).not.toBeNull();
      expect(() => f.relays.start(1, f.request)).toThrow('shutting down');
    } finally { await f.contexts.stop(); }
  });

  test('archives terminal results and objectives independently of owner teardown', async () => {
    const path = await directory();
    const f = await relayFixture(new CodexChatRelayHistory(path));
    try {
      const start = f.relays.start(1, f.request);
      await f.completed;
      const records = await f.relays.listHistory(1);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: start.id, objective: f.request.objective,
        state: { status: 'completed', outcome: 'reviewed', summary: 'Answer turn-3' } });
      await f.contexts.disposeOwner(1);
      expect((await f.relays.listHistory(2))[0]?.id).toBe(start.id);
      expect((await new CodexChatRelayHistory(path).list())[0]?.state.status).toBe('completed');
    } finally { await f.contexts.stop(); }
  });

  test('reports persistence failures on live state without losing the conversation result', async () => {
    const path = await directory();
    await writeFile(join(path, 'broken.json'), '{invalid');
    const f = await relayFixture(new CodexChatRelayHistory(path));
    try {
      f.relays.start(1, f.request);
      await f.completed;
      expect((await f.failure).historyError).toContain('Could not save conversation history');
      await expectFailure(f.relays.listHistory(1), 'preserved');
      expect(f.relays.get(1)).toMatchObject({ status: 'completed', summary: 'Answer turn-3' });
      expect(f.relays.get(1)?.historyError).toContain('preserved');
      expect(await readFile(join(path, 'broken.json'), 'utf8')).toBe('{invalid');
    } finally { await f.contexts.stop(); }
  });
});

test('history deletion serializes snapshots and prevents late persistence from resurrecting a record', async () => {
  const path = await directory();
  const history = new CodexChatRelayHistory(path);
  const first = history.save(record());
  const deleting = history.delete('relay-a');
  const lateSave = history.save(record());
  await Promise.all([first, lateSave]);
  expect(await deleting).toEqual({ id: 'relay-a' });
  await history.save(record('relay-b'));
  expect(await history.delete('relay-a')).toEqual({ id: 'relay-a' });
  expect((await new CodexChatRelayHistory(path).list()).map((item) => item.id)).toEqual(['relay-b']);
  for (const id of [null, 1, '', '../outside', 'relay-a/..', 'relay-a\n', 'a'.repeat(129)]) {
    expect(() => history.delete(id)).toThrow('Invalid conversation history id');
  }
  expect((await history.list()).map((item) => item.id)).toEqual(['relay-b']);
});

test('deleting terminal relay history clears latest state and preserves original chats', async () => {
  const path = await directory();
  const history = new CodexChatRelayHistory(path);
  const f = await relayFixture(history);
  try {
    const started = f.relays.start(1, f.request);
    await expectFailure(f.relays.deleteHistory(2, started.id), 'Stop the conversation relay');
    await f.completed;
    expect(await f.relays.deleteHistory(2, started.id)).toEqual({ id: started.id });
    expect(f.relays.get(1)).toBeNull();
    expect(await f.relays.listHistory(1)).toEqual([]);
    await f.relays.shutdown();
    expect(await new CodexChatRelayHistory(path).list()).toEqual([]);
    expect(f.contexts.existing(1, 'source')?.viewedThreadId).toBe('source-thread');
    expect(f.contexts.existing(1, 'target')?.viewedThreadId).toBe('target-thread');
  } finally { await f.contexts.stop(); }
});

test('stopping relay history cannot be deleted until terminal persistence finishes', async () => {
  const path = await directory();
  const f = await relayFixture(new CodexChatRelayHistory(path));
  try {
    const started = f.relays.start(1, f.request);
    expect(f.relays.stop(1)?.status).toBe('stopping');
    await expectFailure(f.relays.deleteHistory(1, started.id), 'Stop the conversation relay');
    await f.relays.shutdown();
    expect(await f.relays.deleteHistory(1, started.id)).toEqual({ id: started.id });
    expect(await f.relays.listHistory(1)).toEqual([]);
  } finally { await f.contexts.stop(); }
});

test('IPC validates the sender before deleting only local history snapshots', async () => {
  const path = await directory();
  const history = new CodexChatRelayHistory(join(path, 'history'));
  const savedTurns = new CodexChatSavedTurns(join(path, 'saved'));
  await history.save(record());
  const saved = await savedTurns.save({ threadId: 'source-thread', itemId: 'answer', sessionTitle: 'Test',
    userText: 'Question', assistantText: 'Answer', createdAt: 1 });
  const f = await relayFixture(history);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  registerCodexChatIpc({ ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    service() { throw new Error('Original chat must not be accessed.'); }, relays: f.relays, savedTurns,
    assertSender(event) { if (event.sender.id !== 1) throw new Error('Invalid sender'); },
    async prepareMessage() { throw new Error('Unused'); },
  });
  try {
    const allowed = { sender: { id: 1 } } as IpcMainInvokeEvent;
    const rejected = { sender: { id: 2 } } as IpcMainInvokeEvent;
    const removeHistory = handlers.get('cheshi:delete-codex-chat-relay-history')!;
    const removeSaved = handlers.get('cheshi:delete-codex-saved-turn')!;
    expect(() => removeHistory(rejected, 'relay-a')).toThrow('Invalid sender');
    expect(() => removeSaved(rejected, saved.id)).toThrow('Invalid sender');
    expect(await history.list()).toHaveLength(1);
    expect(await savedTurns.list()).toHaveLength(1);
    expect(await removeHistory(allowed, 'relay-a')).toEqual({ id: 'relay-a' });
    expect(await removeSaved(allowed, saved.id)).toEqual({ id: saved.id });
    expect(await history.list()).toEqual([]);
    expect(await savedTurns.list()).toEqual([]);
  } finally { await f.contexts.stop(); }
});
