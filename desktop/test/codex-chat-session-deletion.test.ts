import { expect, test } from 'bun:test';
import type { IpcMainInvokeEvent } from 'electron';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatRelays } from '../lib/codex-chat-relay.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

const cwd = '/workspace/cheshi';
const rootThread = () => codexThread('root', { cwd });
const childThread = () => codexThread('child', { cwd, parentThreadId: 'root' });
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected the operation to fail.');
}
function fixture(responses: Record<string, unknown> = {}, conversations?: CodexConversationAccess) {
  const defaults = { 'thread/read': { thread: rootThread() },
    'thread/list': { data: [], nextCursor: null }, 'thread/delete': {}, ...responses };
  const client = createFakeCodexClient(defaults);
  const service = conversations ? new CodexChatService({ client, conversations, cwd,
    serviceName: 'test', developerInstructions: 'Test.' }) : createCodexChatService(client);
  const events: Record<string, unknown>[] = [];
  const contexts = new CodexChatContexts({ service: { cwd, serviceName: 'test', developerInstructions: 'Test.' },
    createClient: () => ({ ...createFakeCodexClient(defaults), async stop() {} }),
    emit(ownerId, event) { events.push({ ownerId, ...event }); } });
  const relays = new CodexChatRelays({ contexts, emit() {} });
  const deletion = new CodexChatSessionDeletion({ service, contexts, relays });
  return { client, service, contexts, relays, deletion, events,
    async close() { service.stop(); await contexts.stop(); } };
}

test('deletes a workspace root and all paginated archived descendants once, resetting only affected panes', async () => {
  const f = fixture({ 'thread/list': (params: Record<string, unknown>) => params.archived
    ? { data: [codexThread('archived', { cwd, parentThreadId: 'child' })], nextCursor: null }
    : params.cursor ? { data: [childThread()], nextCursor: null } : { data: [], nextCursor: 'next' } });
  try {
    f.service.viewedThreadId = 'root';
    f.service.selectedPermissionModeId = 'full-access';
    f.service.subscribedThreadIds.add('root');
    const sameRoot = f.contexts.get(1, 'same'); sameRoot.viewedThreadId = 'root';
    const child = f.contexts.get(2, 'child'); child.viewedThreadId = 'child'; child.viewedThreadIsSubagent = true;
    const other = f.contexts.get(1, 'other'); other.viewedThreadId = 'other'; other.selectedPermissionModeId = 'full-access';
    expect(await f.deletion.deleteSession(f.service, 'root')).toEqual({ threadIds: ['root', 'child', 'archived'] });
    expect(f.client.requests.filter(request => request.method === 'thread/delete')).toEqual([{ method: 'thread/delete', params: { threadId: 'root' } }]);
    expect(f.client.requests.filter(request => request.method === 'thread/list')).toHaveLength(3);
    expect(f.client.requests.find(request => request.method === 'thread/list')?.params).toMatchObject({ modelProviders: [], sourceKinds: expect.arrayContaining(['subAgentThreadSpawn']) });
    expect(f.service.viewedThreadId).toBeNull();
    expect(f.service.selectedPermissionModeId).toBe('read-only');
    expect(f.service.subscribedThreadIds.has('root')).toBe(false);
    expect(sameRoot.viewedThreadId).toBeNull();
    expect(child.viewedThreadId).toBeNull();
    expect(child.viewedThreadIsSubagent).toBe(false);
    expect(other.viewedThreadId).toBe('other');
    expect(other.selectedPermissionModeId).toBe('full-access');
    expect(f.events.filter(event => event.type === 'sessions-deleted')).toHaveLength(3);
  } finally { await f.close(); }
});

function catalogFixture() {
  const locations = [{ profileId: 'a', threadId: 'root' }, { profileId: 'b', threadId: 'root' },
    { profileId: 'b', threadId: 'fork' }];
  const key = (profileId: string, threadId: unknown) => `${profileId}:${String(threadId)}`;
  const threads = new Map<string, Record<string, unknown>>(locations.map(location => [key(location.profileId, location.threadId),
    codexThread(location.threadId, { cwd, forkedFromId: location.threadId === 'fork' ? 'root' : null })]));
  const descendants = new Map<string, Record<string, unknown>[]>();
  const requests: { profileId: string; method: string; params: Record<string, unknown> }[] = [];
  const failedDeletions = new Set<string>();
  const forgotten: string[] = [];
  const conversations: CodexConversationAccess = {
    async list() { return { sessions: [] }; }, async resolve(id) { return id; },
    async locations() { return locations; }, async forget(id) { forgotten.push(id); },
    async request(profileId, method, value) {
      const params = value as Record<string, unknown>;
      requests.push({ profileId, method, params });
      if (method === 'thread/read') {
        const thread = threads.get(key(profileId, params.threadId));
        if (!thread) throw new Error('Thread missing');
        return { thread };
      }
      if (method === 'thread/list') return { data: params.archived === true ? []
        : descendants.get(key(profileId, params.ancestorThreadId)) ?? [], nextCursor: null };
      if (method === 'thread/delete') {
        const target = key(profileId, params.threadId);
        if (failedDeletions.has(target)) throw new Error('Delete failed');
        const deleting = new Set([params.threadId, ...descendants.get(target)?.map(thread => thread.id) ?? []]);
        const candidates = [...threads, ...[...descendants].flatMap(([owner, children]) => children.map(thread => [owner, thread] as const))];
        if (candidates.some(([location, thread]) => location.startsWith(`${profileId}:`)
          && !deleting.has(thread.id) && deleting.has(thread.forkedFromId))) {
          const error = new Error(`cannot delete thread ${String(params.threadId)}: forked history still references it`);
          error.name = 'CodexRequestRejectedError';
          throw error;
        }
        if (!threads.delete(target)) throw new Error('Thread already deleted');
        descendants.delete(target);
        return {};
      }
      throw new Error('Unexpected request');
    },
  };
  return { ...fixture({}, conversations), conversations, locations, threads, descendants, requests, failedDeletions, forgotten };
}

test('catalog deletion preflights all account copies and descendants before deleting only their owning locations', async () => {
  const f = catalogFixture();
  try {
    f.descendants.set('a:root', [childThread()]);
    f.descendants.set('b:fork', [codexThread('fork-child', { cwd, parentThreadId: 'fork' })]);
    f.locations.push({ profileId: 'b', threadId: 'fork' });
    f.service.viewedThreadId = 'root';
    const fork = f.contexts.get(1, 'fork'); fork.viewedThreadId = 'fork';
    const child = f.contexts.get(1, 'child'); child.viewedThreadId = 'fork-child';
    const unrelated = f.contexts.get(2, 'other'); unrelated.viewedThreadId = 'other';
    expect(await f.deletion.deleteSession(f.service, 'root')).toEqual({ threadIds: ['root', 'child', 'fork', 'fork-child'] });
    expect(f.requests.filter(request => request.method === 'thread/delete')).toEqual([
      { profileId: 'a', method: 'thread/delete', params: { threadId: 'root' } },
      { profileId: 'b', method: 'thread/delete', params: { threadId: 'fork' } },
      { profileId: 'b', method: 'thread/delete', params: { threadId: 'root' } },
    ]);
    expect(f.requests.slice(f.requests.findIndex(request => request.method === 'thread/delete'))
      .every(request => request.method === 'thread/delete')).toBe(true);
    expect(f.client.requests).toHaveLength(0);
    expect(f.forgotten).toEqual(['root']);
    expect(f.service.viewedThreadId).toBeNull();
    expect(fork.viewedThreadId).toBeNull();
    expect(child.viewedThreadId).toBeNull();
    expect(unrelated.viewedThreadId).toBe('other');
  } finally { await f.close(); }
});

test('catalog deletion follows a three-generation fork chain in each account regardless of location order', async () => {
  const f = catalogFixture();
  try {
    f.locations.splice(0, f.locations.length,
      { profileId: 'a', threadId: 'root' }, { profileId: 'b', threadId: 'root' },
      { profileId: 'a', threadId: 'current' }, { profileId: 'b', threadId: 'middle' },
      { profileId: 'a', threadId: 'middle' });
    f.threads.clear();
    for (const location of f.locations) f.threads.set(`${location.profileId}:${location.threadId}`,
      codexThread(location.threadId, { cwd, forkedFromId: location.threadId === 'current' ? 'middle'
        : location.threadId === 'middle' ? 'root' : null }));
    const result = await f.deletion.deleteSession(f.service, 'current');
    expect(new Set(result.threadIds)).toEqual(new Set(['root', 'middle', 'current']));
    expect(f.requests.filter(request => request.method === 'thread/delete').map(request =>
      `${request.profileId}:${String(request.params.threadId)}`)).toEqual([
      'a:current', 'a:middle', 'a:root', 'b:middle', 'b:root',
    ]);
    expect(f.threads.size).toBe(0);
    expect(f.forgotten).toEqual(['current']);
  } finally { await f.close(); }
});

test('catalog deletion orders forks of subagent history and dependencies carried by subagents', async () => {
  for (const sourceIsChild of [false, true]) {
    const f = catalogFixture();
    try {
      if (sourceIsChild) {
        f.descendants.set('b:root', [childThread()]);
        f.threads.set('b:fork', codexThread('fork', { cwd, forkedFromId: 'child' }));
      } else {
        f.threads.set('b:fork', codexThread('fork', { cwd }));
        f.descendants.set('b:fork', [codexThread('fork-child', { cwd, parentThreadId: 'fork', forkedFromId: 'root' })]);
      }
      await f.deletion.deleteSession(f.service, 'root');
      expect(f.requests.filter(request => request.method === 'thread/delete').map(request =>
        `${request.profileId}:${String(request.params.threadId)}`)).toEqual(['a:root', 'b:fork', 'b:root']);
      expect(f.forgotten).toEqual(['root']);
    } finally { await f.close(); }
  }
});

test('catalog deletion rejects malformed or cyclic fork metadata before deleting any account', async () => {
  for (const source of [123, '', 'fork', 'root']) {
    const f = catalogFixture();
    try {
      f.threads.set('b:fork', codexThread('fork', { cwd, forkedFromId: source }));
      if (source === 'root') f.threads.set('b:root', codexThread('root', { cwd, forkedFromId: 'fork' }));
      expect((await failure(f.deletion.deleteSession(f.service, 'root'))).message).toContain('fork relationship');
      expect(f.requests.some(request => request.method === 'thread/delete')).toBe(false);
      expect(f.forgotten).toHaveLength(0);
    } finally { await f.close(); }
  }
});

test('an external fork blocks deletion with an actionable error without expanding the deletion scope', async () => {
  const f = catalogFixture();
  try {
    f.threads.set('a:external', codexThread('external', { cwd: '/other', forkedFromId: 'root' }));
    f.service.viewedThreadId = 'root';
    const error = await failure(f.deletion.deleteSession(f.service, 'root'));
    expect(error.message).toContain('Delete that fork first');
    expect(error.cause).toBeInstanceOf(Error);
    expect(f.threads.size).toBe(4);
    expect(f.service.viewedThreadId).toBe('root');
    expect(f.forgotten).toHaveLength(0);
    expect(f.requests.filter(request => request.method === 'thread/delete')).toEqual([
      { profileId: 'a', method: 'thread/delete', params: { threadId: 'root' } },
    ]);
  } finally { await f.close(); }
});

test('catalog deletion blocks every account when a later source or descendant is active or unrelated', async () => {
  for (const kind of ['source-active', 'source-foreign', 'child-active', 'pane-active', 'pane-pending']) {
    const f = catalogFixture();
    try {
      if (kind === 'source-active') f.threads.set('b:fork', codexThread('fork', { cwd, status: { type: 'active' } }));
      if (kind === 'source-foreign') f.threads.set('b:fork', codexThread('fork', { cwd: '/other' }));
      if (kind === 'child-active') f.descendants.set('b:fork', [codexThread('agent', { cwd,
        parentThreadId: 'fork', status: { type: 'active' } })]);
      if (kind.startsWith('pane-')) {
        const pane = f.contexts.get(1, 'fork');
        if (kind === 'pane-active') pane.beginActiveTurn('fork', 'turn');
        else pane.pendingTurnStarts.add('fork');
      }
      await failure(f.deletion.deleteSession(f.service, 'root'));
      expect(f.requests.some(request => request.method === 'thread/delete')).toBe(false);
      expect(f.forgotten).toHaveLength(0);
    } finally { await f.close(); }
  }
});

test('catalog partial deletion reports failure and retries only unconfirmed account copies', async () => {
  const f = catalogFixture();
  try {
    f.service.viewedThreadId = 'root';
    f.failedDeletions.add('b:root');
    expect((await failure(f.deletion.deleteSession(f.service, 'root'))).message).toBe('Delete failed');
    expect(f.forgotten).toHaveLength(0);
    expect(f.service.viewedThreadId).toBe('root');
    expect(f.threads.has('a:root')).toBe(false);
    expect(f.threads.has('b:fork')).toBe(false);
    f.failedDeletions.clear();
    expect(await f.deletion.deleteSession(f.service, 'root')).toEqual({ threadIds: ['root', 'fork'] });
    expect(f.requests.filter(request => request.profileId === 'a' && request.method === 'thread/delete')).toHaveLength(1);
    expect(f.requests.filter(request => request.profileId === 'b' && request.method === 'thread/read'
      && request.params.threadId === 'fork')).toHaveLength(1);
    expect(f.requests.filter(request => request.profileId === 'b' && request.method === 'thread/delete'
      && request.params.threadId === 'fork')).toHaveLength(1);
    expect(f.requests.filter(request => request.profileId === 'b' && request.method === 'thread/delete'
      && request.params.threadId === 'root')).toHaveLength(2);
    expect(f.forgotten).toEqual(['root']);
  } finally { await f.close(); }
});

test('catalog deletion never assumes an unknown missing location was already deleted', async () => {
  const f = catalogFixture();
  try {
    f.threads.delete('b:root');
    expect((await failure(f.deletion.deleteSession(f.service, 'root'))).message).toBe('Thread missing');
    expect(f.requests.some(request => request.method === 'thread/delete')).toBe(false);
    expect(f.forgotten).toHaveLength(0);
  } finally { await f.close(); }
});

test('retries saving acknowledged deletion progress before reading or deleting that location again', async () => {
  const f = catalogFixture();
  let failSave = true;
  const saved: string[] = [];
  f.conversations.confirmDeletion = async (_id, deletion) => {
    if (failSave) throw new Error('Saving deletion progress failed');
    saved.push(`${deletion.profileId}:${deletion.threadId}`);
  };
  try {
    expect((await failure(f.deletion.deleteSession(f.service, 'root'))).message).toBe('Saving deletion progress failed');
    expect(f.threads.has('a:root')).toBe(false);
    expect(f.threads.has('b:fork')).toBe(true);
    expect(f.forgotten).toHaveLength(0);
    failSave = false;
    await f.deletion.deleteSession(f.service, 'root');
    expect(saved).toEqual(['a:root', 'b:fork', 'b:root']);
    expect(f.requests.filter(request => request.profileId === 'a' && request.method === 'thread/read')).toHaveLength(1);
    expect(f.requests.filter(request => request.profileId === 'a' && request.method === 'thread/delete')).toHaveLength(1);
    expect(f.forgotten).toEqual(['root']);
  } finally { await f.close(); }
});

test('rejects foreign workspaces, mismatched identities, subagent roots and active server sessions', async () => {
  for (const thread of [codexThread('root', { cwd: '/other' }), codexThread('different', { cwd }),
    codexThread('root', { cwd, parentThreadId: 'parent' }), codexThread('root', { cwd, status: { type: 'active', activeFlags: [] } }),
    codexThread('root'), { id: 'root', cwd }]) {
    const f = fixture({ 'thread/read': { thread } });
    try {
      await failure(f.deletion.deleteSession(f.service, 'root'));
      expect(f.client.requests.some(request => request.method === 'thread/delete')).toBe(false);
    } finally { await f.close(); }
  }
});

test('accepts the schema-defined omitted final cursor', async () => {
  const f = fixture({ 'thread/list': { data: [] } });
  try {
    expect(await f.deletion.deleteSession(f.service, 'root')).toEqual({ threadIds: ['root'] });
  } finally { await f.close(); }
});

test('rejects active or pending affected panes including descendants', async () => {
  for (const pending of [false, true]) {
    const f = fixture({ 'thread/list': { data: [childThread()], nextCursor: null } });
    try {
      const child = f.contexts.get(2, 'child');
      if (pending) child.pendingTurnStarts.add('child'); else child.beginActiveTurn('child', 'running');
      expect((await failure(f.deletion.deleteSession(f.service, 'root'))).message).toContain('every chat pane');
      expect(f.client.requests.some(request => request.method === 'thread/delete')).toBe(false);
    } finally { await f.close(); }
  }
});

test('rejects a related running relay even between turns', async () => {
  const f = fixture();
  try {
    f.contexts.get(1, 'pane');
    const deletion = new CodexChatSessionDeletion({ service: f.service, contexts: f.contexts,
      relays: { get: () => ({ status: 'running', sourceThreadId: 'root', targetThreadId: 'other' }) as ReturnType<CodexChatRelays['get']> } });
    expect((await failure(deletion.deleteSession(f.service, 'root'))).message).toContain('relay');
    expect(f.client.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test('fails closed for malformed pages, repeating cursors and unrelated descendants', async () => {
  for (const page of [{ data: null, nextCursor: null }, { data: [], nextCursor: 1 }, { data: [], nextCursor: 'repeat' },
    { data: [codexThread('other', { cwd, parentThreadId: 'not-root' })], nextCursor: null },
    { data: [codexThread('child', { cwd, parentThreadId: 'child' })], nextCursor: null },
    { data: [codexThread('child', { cwd, parentThreadId: 'root', status: { type: 'active' } })], nextCursor: null }]) {
    const f = fixture({ 'thread/list': page });
    try {
      await failure(f.deletion.deleteSession(f.service, 'root'));
      expect(f.client.requests.some(request => request.method === 'thread/delete')).toBe(false);
    } finally { await f.close(); }
  }
});

test('API failure and malformed acknowledgements preserve pane selection and permit a later retry', async () => {
  for (const response of [new Error('Delete denied'), null, []]) {
    let attempts = 0;
    const f = fixture({ 'thread/delete': () => {
      if (++attempts > 1) return {};
      if (response instanceof Error) throw response;
      return response;
    } });
    try {
      f.service.viewedThreadId = 'root';
      await failure(f.deletion.deleteSession(f.service, 'root'));
      expect(f.service.viewedThreadId).toBe('root');
      expect(f.events.some(event => event.type === 'sessions-deleted')).toBe(false);
      expect(await f.deletion.deleteSession(f.service, 'root')).toEqual({ threadIds: ['root'] });
    } finally { await f.close(); }
  }
});

test('direct deletion explains fork-reference rejection while preserving unrelated server errors', async () => {
  for (const message of ['cannot delete thread root: forked history still references it', 'cannot delete thread root: already has an active writer']) {
    const rejection = new Error(message);
    rejection.name = 'CodexRequestRejectedError';
    const f = fixture({ 'thread/delete': rejection });
    try {
      f.service.viewedThreadId = 'root';
      const error = await failure(f.deletion.deleteSession(f.service, 'root'));
      if (message.endsWith('forked history still references it')) {
        expect(error.message).toContain('Delete that fork first');
        expect(error.cause).toBe(rejection);
      } else expect(error).toBe(rejection);
      expect(f.service.viewedThreadId).toBe('root');
      expect(f.events.some(event => event.type === 'sessions-deleted')).toBe(false);
    } finally { await f.close(); }
  }
});

test('waits for existing selection or attachment preparation and blocks new mutations during deletion', async () => {
  const reading = createDeferred<void>();
  const release = createDeferred<unknown>();
  const f = fixture({ 'thread/read': () => { reading.resolve(); return release.promise; } });
  const action = createDeferred<void>();
  try {
    const pending = f.deletion.mutation(() => action.promise);
    expect((await failure(f.deletion.deleteSession(f.service, 'root'))).message).toContain('current chat action');
    expect(f.client.requests).toHaveLength(0);
    action.resolve(); await pending;
    const removing = f.deletion.deleteSession(f.service, 'root');
    await reading.promise;
    let called = false;
    expect((await failure(f.deletion.mutation(() => { called = true; }))).message).toContain('deletion to finish');
    expect(called).toBe(false);
    expect((await failure(f.deletion.deleteSession(f.service, 'root'))).message).toContain('current chat action');
    release.resolve({ thread: rootThread() });
    await removing;
    await f.deletion.mutation(() => { called = true; });
    expect(called).toBe(true);
  } finally { await f.close(); }
});

test('IPC exposes explicit deletion and protects in-flight message preparation', async () => {
  const f = fixture();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const entered = createDeferred<void>();
  const ready = createDeferred<void>();
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
  registerCodexChatIpc({ ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    service() { return f.service; }, relays: f.relays, deletion: f.deletion, assertSender() {},
    savedTurns: { async list() { return []; }, async save() { throw new Error('Unused'); }, async delete() { throw new Error('Unused'); } },
    async prepareMessage() { entered.resolve(); await ready.promise; throw new Error('Attachment canceled'); },
  });
  try {
    const sending = handlers.get('cheshi:send-codex-chat-message')!(event, {}, 'pane');
    await entered.promise;
    await failure(Promise.resolve(handlers.get('cheshi:delete-codex-chat-session')!(event, 'root', 'pane')));
    expect(f.client.requests).toHaveLength(0);
    ready.resolve(); await sending;
    expect(await handlers.get('cheshi:delete-codex-chat-session')!(event, 'root', 'pane')).toEqual({ threadIds: ['root'] });
  } finally { await f.close(); }
});
