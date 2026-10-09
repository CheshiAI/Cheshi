import { expect, test } from 'bun:test';
import { AgentManagementModel } from '../frontend/src/shared/agent-management/agentManagementModel.ts';
import type { AgentDetails, AgentManagementApi, AgentSnapshot } from '../shared/agent-management.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(engineId: string): AgentSnapshot {
  return { engineId, online: true, error: null, agents: [{ id: 'worker', name: 'Verifier', image: 'test', state: 'running' }] };
}
function details(): AgentDetails {
  return { agent: snapshot('test:one').agents[0]!, ready: true, busy: false, authenticated: true, threadId: 'thread',
    error: null, logs: 'saved logs', tasks: [] };
}
function api(overrides: Partial<AgentManagementApi> = {}): AgentManagementApi {
  return { engines: async () => ({ engines: [{ id: 'test:one', name: 'One', supported: true, reason: null }], error: null }),
    snapshot: async id => snapshot(id), details: async () => details(), control: async id => snapshot(id), ...overrides };
}

test('engine discovery refresh preserves the selected worker on the same engine', async () => {
  const model = new AgentManagementModel(api({
    snapshot: async id => ({ ...snapshot(id), agents: [snapshot(id).agents[0]!, { ...snapshot(id).agents[0]!, id: 'second' }] }),
    details: async (_engine, id) => ({ ...details(), agent: { ...details().agent, id } }),
  }));
  await model.discover();
  await model.select('second');
  await model.discover();
  expect(model.snapshot().agentId).toBe('second');
  expect(model.snapshot().details?.agent.id).toBe('second');
  model.dispose();
});

test('engine changes discard late replies from the previous engine', async () => {
  const old = createDeferred<AgentSnapshot>();
  const model = new AgentManagementModel(api({ snapshot: id => id === 'test:one' ? old.promise : Promise.resolve(snapshot(id)) }));
  const pending = model.connect('test:one');
  await model.connect('test:two');
  old.resolve(snapshot('test:one')); await pending;
  expect(model.snapshot().engineId).toBe('test:two');
  expect(model.snapshot().snapshot?.engineId).toBe('test:two');
  expect(model.snapshot().loading).toBe(false);
  model.dispose();
});

test('control waits for native acknowledgment and duplicate actions are ignored', async () => {
  const gate = createDeferred<AgentSnapshot>();
  let calls = 0;
  const model = new AgentManagementModel(api({ control: () => { calls++; return gate.promise; } }));
  await model.discover();
  const pending = model.control('stop');
  await model.control('restart');
  await model.connect('test:two');
  expect(calls).toBe(1);
  expect(model.snapshot().engineId).toBe('test:one');
  expect(model.snapshot().details?.logs).toBe('saved logs');
  expect(model.snapshot().changing).toBe(true);
  gate.reject(new Error('stop failed')); await pending;
  expect(model.snapshot().error).toBe('stop failed');
  expect(model.snapshot().details?.logs).toBe('saved logs');
  expect(model.snapshot().changing).toBe(false);
  model.dispose();
});

test('offline refresh clears actionable selection and disposal ignores pending replies', async () => {
  let online = true;
  const model = new AgentManagementModel(api({ snapshot: async id => online ? snapshot(id)
    : { engineId: id, online: false, error: 'offline', agents: [] } }));
  await model.discover();
  online = false; await model.refresh();
  expect(model.snapshot().agentId).toBe('');
  expect(model.snapshot().details).toBeNull();
  expect(model.snapshot().snapshot?.online).toBe(false);
  model.dispose();
  const gate = createDeferred<AgentDetails>();
  const second = new AgentManagementModel(api({ details: () => gate.promise }));
  const pending = second.connect('test:one');
  await Promise.resolve();
  second.dispose(); const before = second.snapshot();
  gate.resolve(details()); await pending;
  expect(second.snapshot()).toBe(before);
});

test('background refresh retains content and loading state without publishing unchanged data', async () => {
  let pending: ReturnType<typeof createDeferred<AgentDetails>> | null = null;
  const model = new AgentManagementModel(api({ details: async () => pending ? pending.promise : details() }));
  await model.discover();
  const before = model.snapshot();
  let updates = 0;
  model.subscribe(() => { updates++; });
  pending = createDeferred<AgentDetails>();
  const refreshing = model.refresh({ background: true });
  await Promise.resolve();
  expect(model.snapshot()).toBe(before);
  expect(model.snapshot().loading).toBe(false);
  pending.resolve(details()); await refreshing;
  expect(updates).toBe(0);
  expect(model.snapshot()).toBe(before);
  pending = createDeferred<AgentDetails>();
  const changed = model.refresh({ background: true });
  await Promise.resolve();
  expect(model.snapshot().details?.logs).toBe('saved logs');
  pending.resolve({ ...details(), logs: 'new log line' }); await changed;
  expect(updates).toBe(1);
  expect(model.snapshot().details?.logs).toBe('new log line');
  expect(model.snapshot().loading).toBe(false);
  model.dispose();
});

test('background errors retain logs and stale background replies cannot replace a new engine', async () => {
  let pending: ReturnType<typeof createDeferred<AgentDetails>> | null = null;
  const model = new AgentManagementModel(api({ details: async engine => engine === 'test:one' && pending ? pending.promise : details() }));
  await model.discover();
  pending = createDeferred<AgentDetails>();
  const failed = model.refresh({ background: true });
  await Promise.resolve();
  pending.reject(new Error('offline')); await failed;
  expect(model.snapshot().details?.logs).toBe('saved logs');
  expect(model.snapshot().loading).toBe(false);
  pending = createDeferred<AgentDetails>();
  const stale = model.refresh({ background: true });
  await Promise.resolve();
  await model.connect('test:two');
  const current = model.snapshot();
  pending.resolve({ ...details(), logs: 'old engine' }); await stale;
  expect(model.snapshot()).toBe(current);
  model.dispose();
});

test('same-ID restarts clear old health while pending and discard conflicting late detail execution', async () => {
  const startedAt = '2026-10-09T00:00:00Z', restartedAt = '2026-10-09T00:01:00Z';
  let run = startedAt;
  let pending: ReturnType<typeof createDeferred<AgentDetails>> | null = null;
  const worker = () => ({ ...details().agent, startedAt: run, status: { observedAt: Date.now() } });
  const model = new AgentManagementModel(api({
    snapshot: async engineId => ({ ...snapshot(engineId), agents: [worker()] }),
    details: async () => pending ? pending.promise : { ...details(), agent: worker() },
  }));
  await model.discover();
  run = restartedAt; pending = createDeferred<AgentDetails>();
  const refresh = model.refresh({ background: true });
  await Promise.resolve();
  expect(model.snapshot().details).toBeNull();
  pending.resolve({ ...details(), agent: { ...worker(), startedAt } }); await refresh;
  expect(model.snapshot().details).toBeNull();
  expect(model.snapshot().snapshot?.agents[0]?.status).toBeUndefined();
  model.dispose();
});

test.each(['start', 'restart'] as const)('%s request identity clears before success refresh and cannot leak across selection changes', async action => {
  const control = createDeferred<AgentSnapshot>(), inspected = createDeferred<AgentDetails>();
  let subsequent = false;
  const model = new AgentManagementModel(api({ control: () => control.promise,
    snapshot: async id => ({ ...snapshot(id), agents: [details().agent, { ...details().agent, id: 'other' }] }),
    details: async (_engine, id) => subsequent ? inspected.promise : { ...details(), agent: { ...details().agent, id } },
  }));
  await model.discover();
  const pending = model.control(action);
  expect(model.snapshot().pendingControl).toEqual({ engineId: 'test:one', agentId: 'worker', action });
  await model.select('other'); await model.connect('test:two');
  expect(model.snapshot().agentId).toBe('worker'); // Existing operation selection lock is preserved.
  subsequent = true; control.resolve(snapshot('test:one'));
  await Promise.resolve(); await Promise.resolve();
  expect(model.snapshot().pendingControl).toBeNull();
  expect(model.snapshot().loading).toBe(true);
  inspected.resolve(details()); await pending;
  expect(model.snapshot().pendingControl).toBeNull();
  subsequent = false;
  await model.select('other'); expect(model.snapshot().agentId).toBe('other'); expect(model.snapshot().pendingControl).toBeNull();
  await model.connect('test:two'); expect(model.snapshot().engineId).toBe('test:two'); expect(model.snapshot().pendingControl).toBeNull();
  model.dispose();
});

test.each(['start', 'restart'] as const)('%s failure and failed post-success inspection do not retain a request indicator', async action => {
  let failControl = true, failDetails = false;
  const model = new AgentManagementModel(api({ control: async id => {
    if (failControl) throw Error('Control failed');
    failDetails = true; return snapshot(id);
  }, details: async () => { if (failDetails) throw Error('Inspection failed'); return details(); } }));
  await model.discover(); await model.control(action);
  expect(model.snapshot().error).toBe('Control failed'); expect(model.snapshot().pendingControl).toBeNull();
  failControl = false; await model.refresh(); await model.control(action);
  expect(model.snapshot().error).toBe('Inspection failed'); expect(model.snapshot().pendingControl).toBeNull();
  model.dispose();
});
