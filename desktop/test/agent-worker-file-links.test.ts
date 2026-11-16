import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkerFileLinks } from '../lib/agent-platform/worker-file-links.mts';
import { WorkerWorkspaces } from '../lib/agent-platform/worker-workspaces.mts';
import { git } from '../lib/agent-platform/git-workspaces.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { specialistAgent } from './agent-registry-fixtures';
import { assertFailure } from './agent-platform-fixtures.ts';
import { loadForgeConfiguration } from './forge-test-helpers';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-worker-links-')));
  const source = join(root, 'source'), directory = join(root, 'platform'); mkdirSync(source);
  await git(source, ['init', '-b', 'main']);
  writeFileSync(join(source, 'result.txt'), 'source');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', '[test] fixture']);
  const binding = bindingFor(source, 'docker:test', 'dev', 'account');
  const manager = new WorkerWorkspaces(directory), saved = await manager.ensure(binding);
  const opened: string[] = [];
  const open = createWorkerFileLinks({ directory, openPath: async path => { opened.push(path); return ''; } });
  return { root, source, directory, binding, manager, saved, opened, open,
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('file links resolve the saved Homie and account without a running container or source fallback', async () => {
  const f = await fixture();
  try {
    const peerBinding = bindingFor(f.source, 'docker:test', 'peer', 'account');
    const peer = await f.manager.ensure(peerBinding);
    writeFileSync(join(f.saved.workspace, 'new result.txt'), 'Homie output');
    await f.open(f.binding, '/workspace/new%20result.txt:1');
    await f.open(f.binding, './result.txt#L1');
    await f.open(peerBinding, '/workspace/result.txt');
    expect(f.opened).toEqual([join(f.saved.workspace, 'new result.txt'), join(f.saved.workspace, 'result.txt'), join(peer.workspace, 'result.txt')]);
    await assertFailure(f.open(bindingFor(f.source, 'docker:test', 'dev', 'other-account'), '/workspace/result.txt'), /unavailable/);
    await assertFailure(f.open(f.binding, '/workspace/missing.txt'), /ENOENT/);
    expect(f.opened).toHaveLength(3);
  } finally { f.dispose(); }
});

test('Worker links reject traversal, foreign host paths, Git metadata, directories and escaping symlinks', async () => {
  const f = await fixture();
  try {
    createSymbolicLink(join(f.source, 'result.txt'), join(f.saved.workspace, 'escape.txt'));
    createSymbolicLink(join(f.saved.workspace, 'result.txt'), join(f.saved.workspace, 'inside.txt'));
    for (const href of ['/workspace/../result.txt', '%2e%2e/result.txt', '/workspace/%2e%2e/result.txt',
      '/workspace-other/result.txt', join(f.source, 'result.txt'), '/workspace/.git', '/workspace/escape.txt',
      '/workspace/', 'file:///etc/passwd', '//server/file.txt', '/workspace/file%00.txt']) {
      await assertFailure(f.open(f.binding, href), /workspace|file|link/);
    }
    expect(f.opened).toHaveLength(0);
    await f.open(f.binding, '/workspace/inside.txt');
    expect(f.opened).toEqual([join(f.saved.workspace, 'result.txt')]);
    const failing = createWorkerFileLinks({ directory: f.directory, openPath: async () => 'No application is available.' });
    await assertFailure(failing(f.binding, '/workspace/result.txt'), /No application/);
  } finally { f.dispose(); }
});

test('Chats derives file identity from the saved room and message, never the default or caller-supplied Homie', async () => {
  const f = await fixture();
  try {
    const filename = join(f.root, 'chats.json');
    const agents = ['dev', 'peer'].map(id => ({ ...specialistAgent(), id, name: id, accountId: 'account', assignments: [{ workspaceRoot: f.source, instructions: '' }] }));
    const bindings: string[] = [], tasks: (string | undefined)[] = [];
    await f.manager.retainLegacyTasks(f.binding, ['recorded']);
    const options = { filename, registry: () => ({ workspaceRoot: f.source, agents }),
      status: async () => { throw new Error('Must not start or inspect a container.'); },
      dispatch: async () => { throw new Error('Must not dispatch model work.'); },
      openFile: async (binding: ReturnType<typeof bindingFor>, href: string, taskId?: string) => { bindings.push(binding.id); tasks.push(taskId); await f.open(binding, href, taskId); } };
    const initial = createAgentChats(options);
    initial.request(f.source, { action: 'create', id: 'room', name: 'Test', engineId: 'docker:test', members: ['dev', 'peer'], defaultAgentId: 'peer' });
    new ChatsStore(filename).update(s => { s.messages.push(
      { id: 'result', taskId: 'recorded', roomId: 'room', sender: 'dev', recipient: null, threadId: null, kind: 'message', text: '[result](/workspace/result.txt)', createdAt: new Date().toISOString() },
      { id: 'user', roomId: 'room', sender: 'user', recipient: 'dev', threadId: null, kind: 'message', text: 'request', createdAt: new Date().toISOString() }); });
    await initial.dispose();
    const service = createAgentChats(options), request = { action: 'open-file', roomId: 'room', messageId: 'result', href: '/workspace/result.txt' };
    await service.openFile(f.source, { ...request, agentId: 'peer', accountId: 'other' });
    expect(tasks).toEqual(['recorded']);
    expect(bindings).toEqual([f.binding.id]); expect(f.opened).toEqual([join(f.saved.workspace, 'result.txt')]);
    await assertFailure(service.openFile(f.source, { ...request, messageId: 'user' }), /identity/);
    await assertFailure(service.openFile(f.source, { ...request, messageId: 'missing' }), /identity/);
    await assertFailure(service.openFile(f.root, request), /project/);
    await assertFailure(service.openFile(f.source, { ...request, roomId: 'other' }), /project/);
    expect(bindings).toHaveLength(1);
    await service.dispose();
    // Historic links retain the room account even if the current registry account changes.
    agents[0]!.accountId = 'other';
    const restored = createAgentChats(options);
    await restored.openFile(f.source, request);
    expect(bindings.at(-1)).toBe(f.binding.id);
    await restored.dispose();
  } finally { f.dispose(); }
});

test('packaging retains the Worker link resolver and its workspace dependencies', async () => {
  const config = await loadForgeConfiguration(), ignore = config.packagerConfig.ignore;
  if (typeof ignore !== 'function') throw new Error('Missing packaging filter');
  for (const path of ['worker-file-links.mts', 'worker-workspaces.mts', 'git-workspaces.mts', 'managed-worktrees.mts']) {
    expect(ignore(`/desktop/lib/agent-platform/${path}`)).toBe(false);
  }
  expect(ignore('/desktop/shared/local-file-link.ts')).toBe(false);
  expect(ignore('/experiments/codex-specialists/src/task-workspace.ts')).toBe(false);
});

test('historic messages resolve their producing task even after the same Homie starts another task', async () => {
  const f = await fixture();
  try {
    await f.manager.retainLegacyTasks(f.binding, ['old']);
    const first = await f.manager.ensure(f.binding, 'first'), second = await f.manager.ensure(f.binding, 'second');
    writeFileSync(join(first.workspace, 'result.txt'), 'first output');
    writeFileSync(join(second.workspace, 'result.txt'), 'second output');
    const restored = createWorkerFileLinks({ directory: f.directory, openPath: async path => { f.opened.push(path); return ''; } });
    await restored(f.binding, '/workspace/result.txt', 'second');
    await restored(f.binding, '/workspace/result.txt', 'first');
    expect(f.opened).toEqual([join(second.workspace, 'result.txt'), join(first.workspace, 'result.txt')]);
    await assertFailure(restored(f.binding, '/workspace/result.txt', 'missing'), /unavailable/);
    await f.manager.retainLegacyTasks(f.binding, ['old']);
    await restored(f.binding, '/workspace/result.txt', 'old');
    expect(f.opened.at(-1)).toBe(join(f.saved.workspace, 'result.txt'));
  } finally { f.dispose(); }
});

test('ordinary intake links retain their read-only baseline until a goal gets its own worktree', async () => {
  const f = await fixture();
  try {
    const key = `@intake:${f.saved.baseCommit}`, baseline = await f.manager.ensure(f.binding, key);
    await f.manager.recordIntakeView(f.binding, 'question', key);
    await f.open(f.binding, '/workspace/result.txt', 'question');
    expect(f.opened.at(-1)).toBe(join(baseline.workspace, 'result.txt'));
    const task = await f.manager.ensure(f.binding, 'question');
    await f.open(f.binding, '/workspace/result.txt', 'question');
    expect(f.opened.at(-1)).toBe(join(task.workspace, 'result.txt'));
  } finally { f.dispose(); }
});


test('pre-upgrade task links remain readable without starting or migrating the old container', async () => {
  const f = await fixture();
  try {
    await f.open(f.binding, '/workspace/result.txt', 'old-message-task');
    expect(f.opened).toEqual([join(f.saved.workspace, 'result.txt')]);
    await f.manager.retainLegacyTasks(f.binding, ['old-message-task']);
    await assertFailure(f.open(f.binding, '/workspace/result.txt', 'new-missing-task'), /unavailable/);
  } finally { f.dispose(); }
});
