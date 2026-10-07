import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackgroundScheduler, type BackgroundOptions } from '../lib/scheduler/background.mts';
import { createSchedulerNotifications } from '../lib/scheduler/notifications.mts';
import { SchedulerEngine } from '../lib/scheduler/engine.mts';
import { openSchedulerStore } from '../lib/scheduler/store.mts';
import { assertWorkspaceThreadIdle, codexWorkspaceActivity, holdWorkspaceJob, registerWorkspaceChatServices, withWorkspaceFolderDeletion } from '../lib/codex-workspace-activity.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers';
import { createSchedulerDeferred } from './scheduler-test-clock';
import type { ScheduleRun } from '../shared/scheduler';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function directory() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cheshi-background-task-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root;
}
function runRecord(workspace: string): ScheduleRun {
  const plannedAt = new Date(Date.now() + 300_000).toISOString();
  return { id: 'run', scheduleId: 'task:1', workspace, title: 'Review', plannedAt, kind: 'task', status: 'starting', mode: 'auto',
    approvedAt: null, dismissed: true, startedAt: null, finishedAt: null, profileId: null, threadId: null, turnId: null, summary: '',
    snapshot: { title: 'Review', prompt: 'Inspect workspace', startAt: plannedAt, timeZone: 'Asia/Seoul', repeat: 'once', enabled: true,
      threadId: 'old-account-thread', permissionMode: 'read-only', model: null, effort: 'medium' } };
}
async function rejects(operation: () => unknown | Promise<unknown>, message: string) {
  let error: unknown; try { await operation(); } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect(String(error)).toContain(message);
}
function backgroundFixture(gate?: Promise<void>, failRegistration = false) {
  const root = directory(); const calls: string[] = [];
  const options: BackgroundOptions = { userDataDirectory: root, home: root, async openExternal() {},
    codeGraph: { cli: { executable: 'unused', args: [] }, dataRoot: root }, historyDirectory: cwd => path.join(cwd, 'history'),
    accountSelection: () => ({ read: () => 'account-b', write() {} }) };
  const clients: ReturnType<typeof createFakeCodexClient>[] = [];
  const initialized = createSchedulerDeferred<void>();
  // The injected boundary supplies in-memory transports; no credential stores or providers are touched.
  const makeHistory: Parameters<typeof createBackgroundScheduler>[1] = input => ({
    accounts: {
      createClient() {
        const client = createFakeCodexClient({
          'permissionProfile/list': { data: [{ id: ':read-only', allowed: true }] },
          'thread/resume': { thread: codexThread('shared-account-thread') },
          'thread/unsubscribe': {},
          'turn/start': (params: Record<string, unknown>) => {
            calls.push('turn'); client.emit('turn/completed', { threadId: params.threadId,
              turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', text: 'Finished' }] } });
            return { turn: { id: 'turn' } };
          },
        });
        clients.push(client); return { ...client, async stop() { calls.push('client-stop'); } };
      },
      conversations: { async resolve(id: string) { calls.push(id); return 'shared-account-thread'; }, async list() { return { sessions: [] }; } },
      register() {
        if (failRegistration) throw new Error('Registration failed');
        return { activeId: 'account-b', async initialize() { calls.push(input.accountSelection?.read() ?? 'missing'); initialized.resolve(); await gate; },
          async stop() { calls.push('selection-stop'); } };
      },
      async beforeMessage() { calls.push('available-account'); }, async stop() { calls.push('accounts-stop'); },
    },
    search: { async stop() { calls.push('search-stop'); } },
  } as unknown as ReturnType<NonNullable<Parameters<typeof createBackgroundScheduler>[1]>>);
  return { root, calls, clients, initialized, background: createBackgroundScheduler(options, makeHistory) };
}
test('background execution uses shared history and account selection without any workspace window', async () => {
  const f = backgroundFixture(); const patches: Partial<ScheduleRun>[] = [];
  const runner = f.background.get(f.root); await runner.run(runRecord(f.root), patch => patches.push(patch));
  expect(f.background.get(f.root)).toBe(runner);
  expect(f.calls).toContain('account-b'); expect(f.calls).toContain('available-account'); expect(f.calls).toContain('old-account-thread');
  expect(patches).toContainEqual(expect.objectContaining({ profileId: 'account-b' }));
  expect(patches.at(-1)).toMatchObject({ status: 'completed', summary: 'Finished' });
  expect(f.calls).toContain('selection-stop'); expect(f.calls).toContain('search-stop');
  expect(codexWorkspaceActivity(f.root).services.size).toBe(0);
  expect(f.clients.flatMap(client => client.requests).filter(item => item.method === 'turn/start')).toHaveLength(1);
  await withWorkspaceFolderDeletion(f.root, async () => true);
});
test('cancelling during background account startup prevents a later execution and releases resources', async () => {
  const gate = createSchedulerDeferred<void>(); const f = backgroundFixture(gate.promise); const patches: Partial<ScheduleRun>[] = [];
  const runner = f.background.get(f.root); const running = runner.run(runRecord(f.root), patch => patches.push(patch));
  await f.initialized.promise;
  await rejects(() => withWorkspaceFolderDeletion(f.root, async () => true), 'Stop scheduled tasks');
  const cancelling = runner.cancel('run'); gate.resolve(); await Promise.all([running, cancelling]);
  expect(f.calls).not.toContain('turn'); expect(patches.at(-1)?.status).toBe('cancelled');
  expect(f.calls).toContain('selection-stop'); expect(codexWorkspaceActivity(f.root).services.size).toBe(0);
});
test('partial background startup failures clean up before reporting failure', async () => {
  const f = backgroundFixture(undefined, true); const patches: Partial<ScheduleRun>[] = [];
  await f.background.get(f.root).run(runRecord(f.root), patch => patches.push(patch));
  expect(patches.at(-1)).toMatchObject({ status: 'failed', summary: 'Error: Registration failed' });
  expect(f.calls).toContain('accounts-stop'); expect(f.calls).toContain('search-stop');
  expect(codexWorkspaceActivity(f.root).services.size).toBe(0);
});
test('folder deletion and starting a background task are mutually exclusive, including nested folders', async () => {
  const root = directory(); const release = holdWorkspaceJob(path.join(root, 'nested'));
  await rejects(() => withWorkspaceFolderDeletion(root, async () => true), 'Stop scheduled tasks'); release();
  await withWorkspaceFolderDeletion(root, async () => { await rejects(() => holdWorkspaceJob(path.join(root, 'nested')), 'being deleted'); });
  holdWorkspaceJob(root)();
});
test('foreground sends and deletions respect a background conversation and shared mutation gate', async () => {
  const root = directory();
  const client = createFakeCodexClient(); const service = new CodexChatService({ cwd: root, serviceName: 'cheshi', developerInstructions: 'Follow workspace instructions.', client });
  const other = new CodexChatService({ cwd: root, serviceName: 'cheshi', developerInstructions: 'Follow workspace instructions.', client: createFakeCodexClient() });
  const contexts = new CodexChatContexts({ service: { cwd: root, serviceName: 'cheshi', developerInstructions: 'Follow workspace instructions.' }, createClient: () => ({ ...createFakeCodexClient(), async stop() {} }), emit() {} });
  const deletion = new CodexChatSessionDeletion({ service, contexts, relays: { get: () => null } });
  const otherDeletion = new CodexChatSessionDeletion({ service: other, contexts, relays: { get: () => null } });
  const remove = registerWorkspaceChatServices(root, () => [other]);
  try {
    other.pendingTurnStarts.add('shared');
    await rejects(() => assertWorkspaceThreadIdle(root, 'shared'), 'already running');
    await rejects(() => service.sendMessage('Inspect', 'message', null, [], 'shared'), 'already running');
    await rejects(() => deletion.deleteSession(service, 'shared'), 'Stop the session');
    await otherDeletion.mutation(() => rejects(() => deletion.exclusive(async () => true), 'current chat action'));
    expect(client.requests).toHaveLength(0);
  } finally { remove(); await contexts.stop(); await service.stop(); await other.stop(); }
});
test('native notices deduplicate, clicking only opens review, and repeated review clicks are observable', async () => {
  const root = directory(); const store = await openSchedulerStore(path.join(root, 'scheduler.sqlite'));
  const engine = new SchedulerEngine(store); cleanup.push(async () => { await engine.stop(); store.close(); });
  const run = { ...runRecord(root), status: 'pending' as const, dismissed: false, mode: 'manual' as const };
  store.insertRun(run); const notices: Array<{ open(): void; closed: boolean; title: string }> = [];
  const bridge = createSchedulerNotifications({ engine, summary() {}, open: value => engine.review(value.workspace, value.id),
    notify(title, _body, open) { const notice = { open, title, closed: false }; notices.push(notice); return () => { notice.closed = true; }; } });
  try {
    await Promise.resolve(); expect(notices).toHaveLength(1); expect(notices[0]?.title).toBe('Confirm scheduled task');
    notices[0]!.open(); const first = engine.snapshot(root).reviewVersion; notices[0]!.open();
    expect(engine.snapshot(root).reviewVersion).toBeGreaterThan(first!); expect(store.run(run.id)?.status).toBe('pending');
    await engine.act(root, run.id, 'skip'); await Promise.resolve(); expect(notices[0]?.closed).toBe(true);
  } finally { bridge.dispose(); }
});

test('foreground reminders do not also emit native notifications', async () => {
  const root = directory(); const store = await openSchedulerStore(path.join(root, 'scheduler.sqlite'));
  const engine = new SchedulerEngine(store); cleanup.push(async () => { await engine.stop(); store.close(); });
  store.insertRun({ ...runRecord(root), status: 'pending', dismissed: false });
  let visible = true; let notices = 0;
  const bridge = createSchedulerNotifications({ engine, summary() {}, open() {}, shouldNotify: () => !visible,
    notify() { notices++; return () => {}; } });
  try {
    await Promise.resolve(); expect(notices).toBe(0);
    visible = false; engine.review(root, 'run'); await Promise.resolve(); expect(notices).toBe(1);
  } finally { bridge.dispose(); }
});
