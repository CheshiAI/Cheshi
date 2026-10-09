import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkerWorkspaces } from '../lib/agent-platform/worker-workspaces.mts';
import { createWorkerWorkspaceInspection } from '../lib/agent-platform/worker-workspace-inspection.mts';
import { git } from '../lib/agent-platform/git-workspaces.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { specialistAgent } from './agent-registry-fixtures';
import { assertFailure } from './agent-platform-fixtures';
import { parseChatsSnapshot } from '../shared/agent-chats';
import { parseWorkerWorkspaceInspection } from '../shared/worker-workspace';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-worktree-inspection-')));
  const source = join(root, 'source'), directory = join(root, 'platform'); mkdirSync(source);
  await git(source, ['init', '-b', 'main']);
  writeFileSync(join(source, 'file.txt'), 'baseline\n');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', '[test] baseline']);
  const binding = bindingFor(source, 'docker:test', 'dev', 'account'), manager = new WorkerWorkspaces(directory);
  const saved = await manager.ensure(binding, 'first'), opened: string[] = [];
  const inspect = createWorkerWorkspaceInspection({ directory, openPath: async path => { opened.push(path); return ''; } });
  return { root, source, directory, binding, manager, saved, opened, inspect, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('inspection follows the producing task across newer tasks, source branch changes and restart', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.saved.workspace, 'file.txt'), 'first task\n');
    writeFileSync(join(f.saved.workspace, 'new file.txt'), 'new contents\n');
    await git(f.source, ['checkout', '-b', 'next']);
    writeFileSync(join(f.source, 'file.txt'), 'next baseline\n');
    await git(f.source, ['add', '.']); await git(f.source, ['commit', '-m', '[test] next baseline']);
    const second = await f.manager.ensure(f.binding, 'second');
    const inspect = createWorkerWorkspaceInspection({ directory: f.directory, openPath: async path => { f.opened.push(path); return ''; } });
    const first = parseWorkerWorkspaceInspection(await inspect(f.binding, 'first', 'inspect'));
    expect(first).toMatchObject({ state: 'ready', workspace: f.saved.workspace, branch: f.saved.branch, baseBranch: 'refs/heads/main', baseCommit: f.saved.baseCommit, kind: 'task' });
    expect(first.changes).toEqual([{ status: 'M', path: 'file.txt' }, { status: '?', path: 'new file.txt' }]);
    expect(first.diff).toContain('+first task'); expect(first.diff).toContain('+new contents');
    expect(await inspect(f.binding, 'second', 'inspect')).toMatchObject({ state: 'ready', workspace: second.workspace, baseBranch: 'refs/heads/next', changes: [] });
    await inspect(f.binding, 'first', 'open'); expect(f.opened).toEqual([f.saved.workspace]);
    expect(await git(f.source, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(f.saved.workspace, 'file.txt'), 'utf8')).toBe('first task\n');
  } finally { f.dispose(); }
});

test('deleted folders retain their recorded identity and cannot be opened or recreated', async () => {
  const f = await fixture();
  try {
    renameSync(f.saved.workspace, `${f.saved.workspace}-removed`);
    for (const action of ['inspect', 'open'] as const) expect(await f.inspect(f.binding, 'first', action))
      .toMatchObject({ state: 'missing', workspace: f.saved.workspace, branch: f.saved.branch, changes: [] });
    expect(f.opened).toHaveLength(0); expect(existsSync(f.saved.workspace)).toBe(false);
    expect(await f.inspect(f.binding, 'unknown', 'inspect')).toMatchObject({ state: 'missing', workspace: null });
    expect(await f.inspect({ ...f.binding, accountId: 'other' }, 'first', 'inspect')).toMatchObject({ state: 'missing', workspace: null });
  } finally { f.dispose(); }
});

test('changed Git identity and escaping links are never opened or read as the recorded workspace', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.source, 'private.txt'), 'OUTSIDE_CONTENT');
    createSymbolicLink(join(f.source, 'private.txt'), join(f.saved.workspace, 'link.txt'));
    const result = await f.inspect(f.binding, 'first', 'inspect');
    expect(result.state).toBe('ready'); expect(result.diff).toContain('symbolic link'); expect(result.diff).not.toContain('OUTSIDE_CONTENT');
    await git(f.saved.workspace, ['checkout', '-b', 'changed']);
    expect(await f.inspect(f.binding, 'first', 'open')).toMatchObject({ state: 'unavailable' });
    expect(f.opened).toHaveLength(0);
    renameSync(f.saved.workspace, `${f.saved.workspace}-original`); createSymbolicLink(f.source, f.saved.workspace);
    expect(await f.inspect(f.binding, 'first', 'open')).toMatchObject({ state: 'unavailable' });
    expect(f.opened).toHaveLength(0);
  } finally { f.dispose(); }
});

test('legacy records have unknown source branch; intake uses its recorded baseline instead of the latest source', async () => {
  const f = await fixture();
  try {
    const path = readdirSync(dirname(f.saved.workspace)).filter(p => p.endsWith('.json'))[0]!;
    const filename = join(dirname(f.saved.workspace), path), record = JSON.parse(readFileSync(filename, 'utf8'));
    delete record.baseBranch; writeFileSync(filename, JSON.stringify(record));
    expect(await f.inspect(f.binding, 'first', 'inspect')).toMatchObject({ baseBranch: null, state: 'ready' });
    const intake = `@intake:${f.saved.baseCommit}`;
    const saved = await f.manager.ensure(f.binding, intake);
    await f.manager.recordIntakeView(f.binding, 'intake-task', intake);
    expect(await f.inspect(f.binding, 'intake-task', 'inspect')).toMatchObject({ kind: 'intake', workspace: saved.workspace, baseCommit: f.saved.baseCommit });
  } finally { f.dispose(); }
});

test('large previews are bounded and binary files are identified', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.saved.workspace, 'file.txt'), 'long line\n'.repeat(20000));
    writeFileSync(join(f.saved.workspace, 'binary.dat'), Buffer.from([1, 0, 2]));
    const result = parseWorkerWorkspaceInspection(await f.inspect(f.binding, 'first', 'inspect'));
    expect(result.state).toBe('ready'); expect(result.truncated).toBe(true); expect(result.diff.length).toBe(160000);
    expect(result.changes.some(change => change.path === 'binary.dat')).toBe(true);
    writeFileSync(join(f.saved.workspace, 'file.txt'), 'baseline\n');
    expect((await f.inspect(f.binding, 'first', 'inspect')).diff).toContain('binary file');
    expect(() => parseWorkerWorkspaceInspection({ ...result, truncated: 'true' })).toThrow();
  } finally { f.dispose(); }
});

test('room lookup derives task, account and engine from saved membership without Docker and survives host restart', async () => {
  const f = await fixture();
  try {
    const agents = ['dev', 'peer'].map(id => ({ ...specialistAgent(), id, name: id, accountId: 'account', assignments: [{ workspaceRoot: f.source, instructions: '' }] }));
    const filename = join(f.root, 'chats.json');
    const options = { filename, registry: () => ({ workspaceRoot: f.source, agents }), workspace: f.inspect,
      status: async () => { throw new Error('No Docker access expected'); }, dispatch: async () => { throw new Error('No agent work expected'); } };
    const initial = createAgentChats(options);
    initial.request(f.source, { action: 'create', id: 'room', name: 'Work', engineId: 'docker:test', members: ['dev', 'peer'], defaultAgentId: 'peer' });
    new ChatsStore(filename).update(state => state.messages.push(
      { id: 'task', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev', taskId: 'first', text: 'Implement', kind: 'message', createdAt: new Date().toISOString() },
      { id: 'delegated', roomId: 'room', threadId: null, sender: 'peer', recipient: 'dev', relatedTask: { agentId: 'dev', taskId: 'first' }, text: 'Review', kind: 'verification_request', createdAt: new Date().toISOString() }));
    await initial.dispose();
    agents[0]!.accountId = 'replacement';
    const service = createAgentChats(options), before = readFileSync(filename, 'utf8');
    const inspected = parseChatsSnapshot(await service.inspectWorkspace(f.source, { action: 'workspace-inspect', roomId: 'room', messageId: 'task', taskId: 'other', agentId: 'peer', path: '/tmp' }));
    expect(inspected.messages[0]?.workspaceInspection).toMatchObject({ workspace: f.saved.workspace, state: 'ready' });
    agents.splice(0, 1);
    await service.inspectWorkspace(f.source, { action: 'workspace-open', roomId: 'room', messageId: 'delegated' });
    expect(f.opened).toEqual([f.saved.workspace]);
    expect(readFileSync(filename, 'utf8')).toBe(before);
    await assertFailure(service.inspectWorkspace(f.source, { action: 'workspace-open', roomId: 'missing', messageId: 'task' }), /Unknown room/);
    await assertFailure(service.inspectWorkspace(f.source, { action: 'workspace-open', roomId: 'room', messageId: 'missing' }), /identity/);
    await service.dispose();
    const restarted = createAgentChats(options);
    expect((await restarted.inspectWorkspace(f.source, { action: 'workspace-inspect', roomId: 'room', messageId: 'task' })).messages[0]?.workspaceInspection?.branch).toBe(f.saved.branch);
    await restarted.dispose();
  } finally { f.dispose(); }
});
