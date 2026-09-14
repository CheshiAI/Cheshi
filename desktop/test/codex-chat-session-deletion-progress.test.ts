import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import type { JsonObject } from '../lib/codex-chat-types.mts';
import { CodexConversationCatalog } from '../lib/codex-conversation-catalog.mts';
import { recordValue } from '../lib/codex-service-utils.mts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';

const cwd = '/workspace/cheshi';
const locations = [
  { profileId: 'a', threadId: 'root' },
  { profileId: 'b', threadId: 'root' },
  { profileId: 'b', threadId: 'fork' },
];

async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected the operation to fail.');
}

function runtime(
  catalog: CodexConversationCatalog,
  request: CodexConversationAccess['request'],
) {
  const client = createFakeCodexClient({
    'thread/resume': (params: JsonObject) => ({ thread: codexThread(String(params.threadId), { cwd }) }),
    'turn/start': (params: JsonObject) => ({ turn: { id: `turn-${String(params.clientUserMessageId)}` } }),
    'thread/unsubscribe': {},
  });
  const resolutions: string[] = [];
  const conversations: CodexConversationAccess = {
    list: () => catalog.list(),
    assertWritable: id => catalog.assertWritable(id),
    resolve: (id, targetClient) => { resolutions.push(id); return catalog.resolve(id, 'b', targetClient); },
    read: (id, method, params) => catalog.read(id, method, params),
    locations: id => catalog.locations(id),
    deletionProgress: id => catalog.deletionProgress(id),
    confirmDeletion: (id, deletion) => catalog.confirmDeletion(id, deletion),
    forget: id => catalog.forget(id), request,
  };
  const options = { cwd, serviceName: 'test', developerInstructions: 'Offline deletion fixture.' };
  const service = new CodexChatService({ ...options, client, conversations });
  const contexts = new CodexChatContexts({ service: options, emit() {},
    createClient() { throw new Error('This fixture must not open additional clients.'); } });
  const deletion = new CodexChatSessionDeletion({ service, contexts, relays: { get: () => null } });
  return { service, client, deletion, resolutions,
    async stop() { await Promise.all([service.stop(), contexts.stop()]); } };
}

async function fixture(failingLocation = 'b:root') {
  const directory = await mkdtemp('/private/tmp/cheshi-deletion-progress-');
  const runtimes: ReturnType<typeof runtime>[] = [];
  try {
    const catalogDirectory = path.join(directory, 'catalog');
    await mkdir(catalogDirectory);
    const ledgerPath = path.join(catalogDirectory, 'conversations.json');
    await writeFile(ledgerPath, JSON.stringify({ version: 1,
      chains: [{ current: locations[2], locations }] }));
    const threads = new Map<string, JsonObject>(locations.map(location => [
      `${location.profileId}:${location.threadId}`,
      codexThread(location.threadId, { cwd, forkedFromId: location.threadId === 'fork' ? 'root' : null }),
    ]));
    const calls: Array<{ profileId: string; method: string; params: JsonObject }> = [];
    let failDeletion = true;
    const request: CodexConversationAccess['request'] = async (profileId, method, raw) => {
      const params = recordValue(raw) ?? {};
      calls.push({ profileId, method, params });
      if (method === 'thread/list') return { data: params.ancestorThreadId || params.archived === true ? []
        : [...threads].filter(([key]) => key.startsWith(`${profileId}:`)).map(([, thread]) => thread), nextCursor: null };
      const key = `${profileId}:${String(params.threadId)}`;
      if (method === 'thread/read') {
        const thread = threads.get(key);
        if (!thread) throw new Error(`Missing thread ${key}`);
        return { thread };
      }
      if (method === 'thread/delete') {
        if ([...threads].some(([location, thread]) => location.startsWith(`${profileId}:`)
          && thread.forkedFromId === params.threadId)) {
          const error = new Error(`cannot delete thread ${String(params.threadId)}: forked history still references it`);
          error.name = 'CodexRequestRejectedError';
          throw error;
        }
        if (key === failingLocation && failDeletion) throw new Error('Temporary account server failure');
        if (!threads.delete(key)) throw new Error(`Duplicate deletion ${key}`);
        return {};
      }
      throw new Error(`Unexpected RPC ${method}`);
    };
    const options = { directory: catalogDirectory, cwd, request,
      profiles: async () => ['a', 'b'].map(id => ({ id, home: path.join(directory, id) })) };
    const catalog = new CodexConversationCatalog(options);
    return { catalog, ledgerPath, threads, calls,
      allowDeletion() { failDeletion = false; },
      restartCatalog: () => new CodexConversationCatalog(options),
      runtime(targetCatalog = catalog) {
        const instance = runtime(targetCatalog, request);
        runtimes.push(instance);
        return instance;
      },
      async stop() {
        await Promise.all(runtimes.map(instance => instance.stop()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('persists partial fork deletion and resumes the visible logical conversation after restart', async () => {
  const h = await fixture();
  const { catalog, ledgerPath, threads, calls } = h;
  try {
    const initial = h.runtime();
    expect((await failure(initial.deletion.deleteSession(initial.service, 'fork'))).message)
      .toBe('Temporary account server failure');
    expect([...threads.keys()]).toEqual(['b:root']);
    expect(calls.filter(call => call.method === 'thread/delete').map(call =>
      `${call.profileId}:${String(call.params.threadId)}`)).toEqual(['a:root', 'b:fork', 'b:root']);
    const confirmations = [
      { profileId: 'a', threadId: 'root', threadIds: ['root'] },
      { profileId: 'b', threadId: 'fork', threadIds: ['fork'] },
    ];
    expect(await catalog.deletionProgress('fork')).toEqual(confirmations);
    expect(await catalog.locations('fork')).toEqual(locations);
    const partial = await catalog.list();
    expect(partial.sessions).toHaveLength(1);
    expect(partial.sessions[0]?.id).toBe('fork');
    expect(partial.sessions[0]?.title).toBe('Deletion incomplete');
    const beforeBlockedReads = calls.length;
    const blocked = 'Conversation deletion is incomplete. Retry deleting it before continuing.';
    expect((await failure(catalog.owner('fork'))).message).toBe(blocked);
    expect((await failure(catalog.read('fork', 'thread/read'))).message).toBe(blocked);
    expect((await failure(catalog.resolve('fork', 'b', initial.client))).message).toBe(blocked);
    expect(calls).toHaveLength(beforeBlockedReads);

    await initial.stop();
    const restartedCatalog = h.restartCatalog();
    const restarted = h.runtime(restartedCatalog);
    expect(await restartedCatalog.deletionProgress('fork')).toEqual(confirmations);
    expect((await restartedCatalog.list()).sessions.map(session => session.id)).toEqual(['fork']);
    h.allowDeletion();
    const retryStart = calls.length;
    const result = await restarted.deletion.deleteSession(restarted.service, 'fork');
    expect(new Set(result.threadIds)).toEqual(new Set(['fork', 'root']));
    const retryCalls = calls.slice(retryStart);
    expect(retryCalls.filter(call => call.method === 'thread/delete')).toEqual([
      { profileId: 'b', method: 'thread/delete', params: { threadId: 'root' } },
    ]);
    expect(retryCalls.filter(call => call.method === 'thread/read')).toEqual([
      { profileId: 'b', method: 'thread/read', params: { threadId: 'root', includeTurns: false } },
    ]);
    expect(threads.size).toBe(0);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as { chains: Array<{ deleted?: boolean }> };
    expect(ledger.chains[0]?.deleted).toBe(true);
    expect((await restartedCatalog.list()).sessions).toEqual([]);
    expect(initial.client.requests).toHaveLength(0);
    expect(restarted.client.requests).toHaveLength(0);
    expect(calls.some(call => call.method === 'turn/start' || call.method === 'thread/fork')).toBe(false);
  } finally { await h.stop(); }
});

async function sendAndComplete(instance: ReturnType<typeof runtime>, messageId: string) {
  const result = await instance.service.sendMessage('Offline fixture message', messageId);
  instance.client.emit('turn/completed', {
    threadId: result.threadId, turn: { id: result.turnId, status: 'completed', items: [] },
  });
  return result;
}

test('blocks subscribed writes after partial account deletion while preserving unrelated conversations', async () => {
  const h = await fixture('b:fork');
  try {
    h.threads.set('b:healthy', codexThread('healthy', { cwd }));
    const initial = h.runtime();
    await initial.service.openSession('fork');
    expect(await sendAndComplete(initial, 'first')).toEqual({ threadId: 'fork', turnId: 'turn-first' });
    expect(initial.service.subscribedThreadIds.has('fork')).toBe(true);

    const beforeCachedSend = initial.client.requests.length;
    const beforeCachedHistory = h.calls.length;
    expect(await sendAndComplete(initial, 'cached')).toEqual({ threadId: 'fork', turnId: 'turn-cached' });
    expect(initial.resolutions).toEqual(['fork']);
    expect(initial.client.requests.slice(beforeCachedSend).map(call => call.method)).toEqual(['turn/start']);
    expect(h.calls).toHaveLength(beforeCachedHistory);

    expect((await failure(initial.deletion.deleteSession(initial.service, 'fork'))).message)
      .toBe('Temporary account server failure');
    expect(h.calls.filter(call => call.method === 'thread/delete').map(call =>
      `${call.profileId}:${String(call.params.threadId)}`)).toEqual(['a:root', 'b:fork']);
    expect([...h.threads.keys()]).toEqual(['b:root', 'b:fork', 'b:healthy']);
    expect(await h.catalog.deletionProgress('fork')).toEqual([
      { profileId: 'a', threadId: 'root', threadIds: ['root'] },
    ]);
    expect(initial.service.viewedThreadId).toBe('fork');
    expect(initial.service.subscribedThreadIds.has('fork')).toBe(true);

    const blocked = 'Conversation deletion is incomplete. Retry deleting it before continuing.';
    const beforeBlockedSend = initial.client.requests.length;
    const beforeBlockedHistory = h.calls.length;
    const sendError = await failure(initial.service.sendMessage('Must remain unsent', 'blocked-live'));
    expect(sendError.message).toBe(blocked);
    expect(sendError.name).toBe('CodexMessageNotSent');
    expect(initial.client.requests).toHaveLength(beforeBlockedSend);
    expect(h.calls).toHaveLength(beforeBlockedHistory);
    expect(initial.resolutions).toEqual(['fork']);
    expect(initial.service.activeTurns.size).toBe(0);
    expect(initial.service.pendingTurnStarts.size).toBe(0);

    const restartedCatalog = h.restartCatalog();
    const restarted = h.runtime(restartedCatalog);
    for (const id of ['fork', 'root']) {
      expect((await failure(restartedCatalog.assertWritable(id))).message).toBe(blocked);
      expect((await failure(restarted.service.sendMessage('Must remain unsent', `blocked-${id}`, null, [], id))).message)
        .toBe(blocked);
    }
    expect((await failure(restarted.service.openSession('fork'))).message).toBe(blocked);
    expect(restarted.client.requests.map(call => call.method)).toEqual(['model/list']);
    expect(h.calls).toHaveLength(beforeBlockedHistory);
    expect(restarted.resolutions).toHaveLength(0);

    for (const instance of [initial, restarted]) {
      await instance.service.openSession('healthy');
      expect(await sendAndComplete(instance, 'healthy')).toEqual({ threadId: 'healthy', turnId: 'turn-healthy' });
      expect(instance.client.requests.some(call => call.method === 'thread/fork')).toBe(false);
    }
  } finally { await h.stop(); }
});
