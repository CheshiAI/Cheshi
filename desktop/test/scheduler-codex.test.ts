import { describe, expect, test } from 'bun:test';
import { SchedulerCodexRunner } from '../lib/scheduler/codex-runner.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';
import type { ScheduleRun } from '../shared/scheduler.ts';
import { loadForgeConfiguration } from './forge-test-helpers.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
function runRecord(threadId: string | null = null): ScheduleRun {
  return { id: 'run-one', scheduleId: 'schedule:1', workspace: '/workspace', title: 'Task', kind: 'task',
    plannedAt: new Date().toISOString(), startedAt: null, finishedAt: null, status: 'starting', mode: 'auto', approvedAt: null,
    dismissed: true, summary: '', profileId: null, threadId: null, turnId: null,
    snapshot: { title: 'Task', prompt: 'Inspect the workspace', startAt: new Date().toISOString(), timeZone: 'Asia/Seoul', repeat: 'once', enabled: true,
      threadId, permissionMode: 'ask-for-approval', model: 'test-model', effort: 'high' } };
}
function setup(options: { beforeMessage?: () => Promise<void>; immediate?: boolean; uncertain?: boolean } = {}) {
  const accepted = createDeferred<void>();
  const started = createDeferred<void>();
  const selected: string[] = [];
  const resolves: string[] = [];
  let profileId = 'account-a';
  let client: ReturnType<typeof createFakeCodexClient>;
  const configuration = {
    cwd: '/workspace', serviceName: 'cheshi', developerInstructions: 'Follow the workspace instructions.',
    conversations: {
      async list() { return { sessions: [] }; },
      async resolve(id: string) { resolves.push(id); return 'shared-b'; },
      async locations() { return []; }, async request() { return {}; }, async forget() {},
    },
  };
  const contexts = new CodexChatContexts({ service: configuration, emit() {}, createClient() {
    client = createFakeCodexClient({
      'permissionProfile/list': { data: [{ id: ':read-only', allowed: true }, { id: ':workspace', allowed: true }] },
      'thread/start': { thread: codexThread('new-thread') },
      'thread/resume': { thread: codexThread('shared-b') },
      'thread/unsubscribe': {}, 'turn/interrupt': {},
      'turn/start': (params: Record<string, unknown>) => {
        started.resolve();
        if (options.uncertain) throw new Error('Transport disconnected');
        if (options.immediate) client.emit('turn/completed', { threadId: params.threadId,
          turn: { id: 'turn-one', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Task result' }] } });
        return { turn: { id: 'turn-one' } };
      },
    });
    return { ...client, async stop() {} };
  } });
  const primary = new CodexChatService({ ...configuration, client: createFakeCodexClient() });
  const deletion = new CodexChatSessionDeletion({ service: primary, contexts, relays: { get: () => null } });
  const runner = new SchedulerCodexRunner({ contexts, deletion, profileId: () => profileId,
    async beforeMessage() { await options.beforeMessage?.(); selected.push('selected'); profileId = 'account-b'; } });
  const patches: Partial<ScheduleRun>[] = [];
  const update = (patch: Partial<ScheduleRun>) => { patches.push(patch); if (patch.status === 'running') accepted.resolve(); };
  return { runner, contexts, primary, patches, update, selected, resolves, accepted, started, client: () => client! };
}
describe('scheduled Codex execution', () => {
  test('uses account selection and shared conversation resolution; buffers fast completion', async () => {
    const test = setup({ immediate: true });
    await test.runner.run(runRecord('shared-a'), test.update);
    expect(test.selected).toEqual(['selected']); expect(test.resolves).toContain('shared-a');
    expect(test.patches).toContainEqual(expect.objectContaining({ profileId: 'account-b' }));
    expect(test.patches).toContainEqual({ threadId: 'shared-b', turnId: 'turn-one', status: 'running' });
    expect(test.patches.at(-1)).toMatchObject({ status: 'completed', summary: 'Task result' });
    expect(test.client().requests.find(item => item.method === 'turn/start')?.params).toMatchObject({
      threadId: 'shared-b', effort: 'high', model: 'test-model', approvalPolicy: 'on-request', approvalsReviewer: 'user',
    });
    expect(test.contexts.allServices()).toHaveLength(0); expect(test.runner.busy).toBe(false);
    await test.primary.stop();
  });
  test('fresh sessions do not replace the foreground conversation; live contexts participate in account gates', async () => {
    const test = setup();
    const promise = test.runner.run(runRecord(), test.update);
    await test.accepted.promise;
    expect(test.primary.viewedThreadId).toBeNull();
    expect(test.contexts.allServices().some(item => item.service.activeTurns.has('new-thread'))).toBe(true);
    expect(test.runner.busy).toBe(true);
    test.client().emit('turn/completed', { threadId: 'new-thread', turn: { id: 'turn-one', status: 'completed', items: [] } });
    await promise; expect(test.runner.busy).toBe(false); await test.primary.stop();
  });
  test('tool permissions require a separate response even for auto tasks', async () => {
    const test = setup(); const promise = test.runner.run(runRecord(), test.update); await test.accepted.promise;
    const counts: number[] = []; const remove = test.runner.subscribe(() => counts.push(test.runner.attention()[0]?.approvals.length ?? 0));
    test.client().emitRequest(7, 'item/commandExecution/requestApproval', { threadId: 'new-thread', turnId: 'turn-one', command: 'echo inspect' });
    const approval = test.runner.attention()[0]?.approvals[0]; expect(approval?.detail).toBe('echo inspect');
    expect(counts.at(-1)).toBe(1);
    expect(test.client().responsesSent).toHaveLength(0);
    await test.runner.respondApproval('run-one', approval!.id, 'decline');
    expect(test.client().responsesSent[0]).toMatchObject({ id: 7, result: { decision: 'decline' } });
    expect(counts.at(-1)).toBe(0); remove();
    test.client().emit('turn/completed', { threadId: 'new-thread', turn: { id: 'turn-one', status: 'completed', items: [] } });
    await promise; await test.primary.stop();
  });
  test('a disconnected send is uncertain and is not retried', async () => {
    const test = setup({ uncertain: true }); await test.runner.run(runRecord(), test.update);
    expect(test.patches.at(-1)?.status).toBe('unknown');
    expect(test.client().requests.filter(item => item.method === 'turn/start')).toHaveLength(1); await test.primary.stop();
  });
  test('a definitive turn error releases the runner even without a completion event', async () => {
    const test = setup(); const promise = test.runner.run(runRecord(), test.update); await test.accepted.promise;
    test.client().emit('error', { threadId: 'new-thread', turnId: 'turn-one', willRetry: false, error: { message: 'Quota exhausted' } });
    await promise;
    expect(test.patches.at(-1)).toMatchObject({ status: 'failed', summary: 'Quota exhausted' });
    expect(test.runner.busy).toBe(false); await test.primary.stop();
  });
  test('closing during account selection prevents a later turn from starting', async () => {
    const gate = createDeferred<void>(); const test = setup({ beforeMessage: () => gate.promise });
    const promise = test.runner.run(runRecord(), test.update);
    const cancelling = test.runner.cancel('run-one'); gate.resolve();
    await Promise.all([promise, cancelling]);
    expect(test.contexts.allServices()).toHaveLength(0);
    expect(test.patches.at(-1)?.status).toBe('cancelled'); await test.primary.stop();
  });
  test('cancel confirms interruption without depending on a later completion notification', async () => {
    const test = setup(); const promise = test.runner.run(runRecord(), test.update); await test.accepted.promise;
    await test.runner.cancel('run-one'); await promise;
    expect(test.client().requests.some(item => item.method === 'turn/interrupt')).toBe(true);
    expect(test.patches.at(-1)?.status).toBe('cancelled'); await test.primary.stop();
  });
  test('all scheduler source dependencies are retained in packaged applications', async () => {
    const config = await loadForgeConfiguration();
    const ignore = config.packagerConfig.ignore;
    if (typeof ignore !== 'function') throw new Error('Expected packaging filter');
    for (const file of ['store', 'engine', 'codex-runner', 'application', 'workspace', 'calendar', 'subscriptions', 'calendar-tasks', 'background', 'desktop', 'notifications', 'migration']) expect(ignore(`/desktop/lib/scheduler/${file}.mts`)).toBe(false);
    for (const file of ['apple-calendar-watch', 'apple-calendar-changes', 'codex-workspace-activity']) expect(ignore(`/desktop/lib/${file}.mts`)).toBe(false);
    expect(ignore('/desktop/shared/calendar-task.ts')).toBe(false);
    expect(ignore('/desktop/shared/scheduler.ts')).toBe(false);
    expect(ignore('/desktop/shared/scheduler-time.ts')).toBe(false);
    expect(ignore('/desktop/lib/workspace-chat-service-options.mts')).toBe(false);
    expect(ignore('/desktop/lib/scheduler/local.sqlite')).toBe(true);
  });
});
