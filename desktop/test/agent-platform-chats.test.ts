import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPlatformChats } from '../lib/agent-platform/chat-service.mts';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { parseChatsRequest } from '../shared/agent-chats.ts';
import type { ChatsRequest } from '../shared/agent-chats.ts';
import { executor, fixture, plan, receipt, assertFailure, createDeferred } from './agent-platform-fixtures.ts';
import { specialistAgent } from './agent-registry-fixtures.ts';
import { git, revision } from '../lib/agent-platform/git-workspaces.mts';

async function chatFixture(failCheck = false) {
  const f = await fixture(executor(async request => receipt(request)));
  const agent = { ...specialistAgent(), accountId: 'account', assignments: [{ workspaceRoot: f.repository, instructions: '' }] };
  let runs = 0;
  const platform = createPlatformChats({ directory: join(f.root, 'chat-platform'), buildContext: '/build',
    profile: async () => { throw new Error('Unexpected live profile request'); }, prepareEnvironment: async () => {},
    executor: async (_context, changed) => ({ image: plan.image, cleanup: async () => {}, executor: executor(async request => {
      if (request.writable) {
        runs++; expect(request.task?.assignee).toBe(agent.id);
        changed({ sessionId: 'native-thread', output: 'Editing feature.txt' });
        writeFileSync(join(request.workspace, 'feature.txt'), 'implemented');
        return { ...receipt(request, 0, 'Task implemented'), session: { agentId: agent.id, accountId: 'account', model: null, threadId: 'native-thread' } };
      }
      return new Promise(resolve => execFile(request.command[0]!, request.command.slice(1), { cwd: request.workspace, timeout: 5000 }, (error, stdout, stderr) => resolve(receipt(request, error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout + stderr))));
    }) }),
  });
  const filename = join(f.root, 'chats.json');
  const options = { filename, platform, registry: () => ({ workspaceRoot: f.repository, agents: [agent] }),
    status: async () => ({ details: null }), dispatch: async () => { throw new Error('Isolated tasks must not reach the shared worker.'); } };
  const chats = createAgentChats(options);
  chats.request(f.repository, { action: 'create', id: 'room', name: 'Room', engineId: 'docker:test', members: [agent.id], defaultAgentId: agent.id });
  const input = { action: 'isolated-submit' as const, id: 'message', roomId: 'room', agentId: agent.id, prompt: 'Implement feature', scope: ['feature.txt'], check: failCheck ? 'exit 7' : 'test "$(cat feature.txt)" = implemented' };
  const message = () => chats.request(f.repository, { action: 'list' }).messages.find(m => m.id === input.id)!;
  return { ...f, chats, options, filename, input, message, agent, runs: () => runs };
}

test('chat submission runs one isolated session, commits and verifies, survives reload and rejects duplicate delivery', async () => {
  const f = await chatFixture();
  try {
    const source = await revision(f.repository, 'HEAD');
    await f.chats.isolated(f.repository, f.input);
    await f.chats.isolated(f.repository, f.input);
    await f.chats.isolatedSettled();
    const result = f.message();
    expect(result.status).toBe('completed'); expect(result.isolated?.phase).toBe('passed');
    expect(result.isolated?.sessionId).toBe('native-thread'); expect(result.isolated?.diff).toContain('+implemented');
    expect(result.isolated?.output).toContain('Verification:'); expect(f.runs()).toBe(1);
    expect(await revision(f.repository, 'HEAD')).toBe(source); expect(existsSync(join(f.repository, 'feature.txt'))).toBe(false);
    const reopened = createAgentChats(f.options);
    expect(reopened.request(f.repository, { action: 'list' }).messages[0]!.isolated).toEqual(result.isolated);
    await reopened.isolated(f.repository, { action: 'isolated-inspect', roomId: 'room', messageId: 'message' });
    await reopened.isolated(f.repository, f.input);
    expect(f.runs()).toBe(1);
    await assertFailure(reopened.isolated(f.repository, { ...f.input, check: 'true' }), /another task/);
    await git(f.repository, ['commit', '--allow-empty', '-m', '[test] advance target']);
    expect((await reopened.isolated(f.repository, { action: 'isolated-inspect', roomId: 'room', messageId: 'message' })).messages[0]!.isolated?.phase).toBe('stale');
  } finally { await f.chats.dispose(); f.dispose(); }
});

test('a successful Homie cannot report success when the requested verification fails', async () => {
  const f = await chatFixture(true);
  try {
    await f.chats.isolated(f.repository, f.input); await f.chats.isolatedSettled();
    const work = f.message().isolated!;
    expect(work.phase).toBe('failed'); expect(work.commit).not.toBeNull(); expect(work.error).toContain('code 7');
    expect(f.message().status).toBe('failed');
  } finally { await f.chats.dispose(); f.dispose(); }
});

test('invalid scope, foreign room, changed account and journal failure never dispatch model work', async () => {
  const f = await chatFixture();
  try {
    expect(() => parseChatsRequest({ ...f.input, scope: ['../escape'] })).toThrow('relative');
    await assertFailure(f.chats.isolated(f.root, f.input), /project/);
    await assertFailure(f.chats.isolated(f.repository, { ...f.input, agentId: 'foreign' }), /participant/);
    f.agent.accountId = 'changed';
    await assertFailure(f.chats.isolated(f.repository, f.input), /identity/);
    f.agent.accountId = 'account';
    mkdirSync(`${f.filename}.tmp`);
    await assertFailure(f.chats.isolated(f.repository, f.input), /EISDIR/);
    expect(f.runs()).toBe(0); expect(f.message()).toBeUndefined();
  } finally { await f.chats.dispose(); f.dispose(); }
});

test('stopping a live isolated job retains unknown outcome and restart never replays it', async () => {
  const f = await chatFixture(), entered = createDeferred<void>();
  let calls = 0;
  const platform = { ...f.options.platform, run: async (_context: unknown, _saved: unknown, _changed: unknown, signal: AbortSignal) => {
    calls++; entered.resolve();
    await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }); });
  } };
  const service = createAgentChats({ ...f.options, platform });
  try {
    await service.isolated(f.repository, f.input); await entered.promise;
    await assertFailure(service.deleteRoom(f.repository, { action: 'delete', roomId: 'room' }), /pending or unresolved/);
    await service.isolated(f.repository, { action: 'isolated-cancel', roomId: 'room', messageId: 'message' });
    expect(service.request(f.repository, { action: 'list' }).messages[0]!.isolated?.phase).toBe('unknown');
    const reopened = createAgentChats({ ...f.options, platform });
    await reopened.isolated(f.repository, f.input);
    expect(calls).toBe(1);
    const saved = JSON.parse(readFileSync(f.filename, 'utf8'));
    saved.messages[0].isolated.phase = 'running'; saved.messages[0].status = 'running';
    writeFileSync(f.filename, JSON.stringify(saved));
    expect(new ChatsStore(f.filename).snapshot(f.repository).messages[0]!.isolated?.phase).toBe('unknown');
  } finally { await service.dispose(); await f.chats.dispose(); f.dispose(); }
});

test('isolated actions round trip through the public chat contract and do not enter ordinary delivery', async () => {
  const f = await chatFixture();
  try {
    const requests: ChatsRequest[] = [f.input, { action: 'isolated-setup', roomId: 'room' }, { action: 'isolated-inspect', roomId: 'room', messageId: 'message' }, { action: 'isolated-cancel', roomId: 'room', messageId: 'message' }];
    for (const request of requests) {
      expect(parseChatsRequest(request)).toEqual(request);
      expect(() => f.chats.request(f.repository, request)).toThrow('asynchronous');
    }
  } finally { await f.chats.dispose(); f.dispose(); }
});

test('inspection restores the verified candidate after the host misses its final chat update', async () => {
  const f = await chatFixture();
  try {
    await f.chats.isolated(f.repository, f.input); await f.chats.isolatedSettled();
    const verified = f.message().isolated!;
    const saved = JSON.parse(readFileSync(f.filename, 'utf8'));
    Object.assign(saved.messages[0].isolated, { phase: 'checking', workspace: '/stale/task-workspace', branch: 'stale-task-branch', commit: 'a'.repeat(40), output: 'Partial output' });
    saved.messages[0].status = 'running'; writeFileSync(f.filename, JSON.stringify(saved));
    const reopened = createAgentChats(f.options);
    expect(reopened.request(f.repository, { action: 'list' }).messages[0]!.isolated?.phase).toBe('unknown');
    const result = await reopened.isolated(f.repository, { action: 'isolated-inspect', roomId: 'room', messageId: 'message' });
    expect(result.messages[0]!.isolated).toEqual(verified); expect(f.runs()).toBe(1);
    await reopened.dispose();
    saved.messages[0].taskId = 'another-task'; writeFileSync(f.filename, JSON.stringify(saved));
    expect(() => new ChatsStore(f.filename)).toThrow('isolated task identity');
  } finally { await f.chats.dispose(); f.dispose(); }
});
