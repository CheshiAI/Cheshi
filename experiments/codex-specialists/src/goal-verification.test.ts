import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import { FakeClient } from './agent-test-client.ts';
import { AgentStore, type Task } from './store.ts';
import { WorkerCustomToolQueue } from './custom-tool-queue.ts';
import { WorkerConversation } from './conversation.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { newGoal, parseGoal } from './decision.ts';
import { parseGoalVerification, reviewGoalVerification, verificationFields } from './goal-verification.ts';
import { record, type JsonRecord } from './protocol.ts';

const directories: string[] = [];
const agents: SpecialistAgent[] = [];
function temporary() { const p = mkdtempSync(join(tmpdir(), 'cheshi-goal-policy-')); directories.push(p); return p; }
afterEach(() => { for (const agent of agents.splice(0)) agent.disposeScratch(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
const readOnly = { basis: 'read_only' as const, reason: 'The user requested a memory search and sourced summary, with no commands or changes.' };
const criteria = ['Search the requested memory', 'Check the original sources', 'Report findings and limits without commands or changes'];
const verified = criteria.map(criterion => ({ criterion, met: true, evidence: 'Observed search and original-source results in this turn.' }));
const decision = { action: 'complete', reason: 'All requested read-only checks performed', progress: 'Sources checked', nextAction: '', criteria: verified };
function fixture(directory = temporary(), writable = false, commandExecution = writable) {
  const store = new AgentStore(directory), client = new FakeClient(), queue = new WorkerCustomToolQueue();
  const agent = new SpecialistAgent({ store, client, customTools: queue, workspace: '/workspace', profile: 'Follow user requirements.',
    collaboration: new WorkerCollaboration(store, 'atlas', '/workspace'), configuration: {
      decisionProtocol: 1, verificationProtocol: 1, conversationProtocol: 1, permissionProtocol: 1, profileId: 'atlas', accountId: 'fixture', role: 'development',
      token: 'a'.repeat(64), instructions: '', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite: writable, commandExecution },
      customTools: [{ name: 'probe', description: 'Read service sessions', enabled: true, runtime: 'bun', script: 'scripts/probe.ts', parameters: [] }],
    } });
  const call = (tool: string, args: JsonRecord = {}) => client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool, arguments: args });
  agents.push(agent);
  return { store, client, agent, call, directory, queue };
}
async function failure(operation: Promise<unknown>, expected: string) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error); expect(String(caught)).toContain(expected);
}
function legacy(f: ReturnType<typeof fixture>, extra: Partial<Task> = {}, userText = 'Search memory about Atlas registration. No commands.') {
  f.store.create('legacy', userText, {
    roomId: 'room', conversation: 'legacy', dialogue: { userText, questions: [], revisions: [] },
    goal: { ...newGoal(true), turns: 1, phase: 'blocked', criteria: verified,
      decisions: [{ ...decision, action: 'blocked', reason: 'verificationRequired=true but list_agents returned agents:[]' }] },
  });
  f.store.update('legacy', { status: 'interrupted', threadId: 'old-thread', output: 'Prior sourced summary', error: 'No independent verifier',
    activity: [{ id: 'memory', turnId: 'old-turn', kind: 'tool', title: 'memory_read', text: 'Prior sources',
      status: 'completed', createdAt: new Date().toISOString(), final: false, truncated: false }], ...extra });
  f.store.saveThread('old-thread', null, 'legacy', true);
}

test('memory-only goals complete without peers even when verification tools and write permissions are available', async () => {
  const f = fixture(undefined, true);
  f.client.onStart = async () => {
    await f.call('start_goal', { objective: 'Summarize memory sources', criteria, verification: readOnly });
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('memory', 'Search memory', { roomId: 'room', conversation: 'memory', goal: false, automatic: true, userText: 'Search memory' });
  await f.agent.settled();
  expect(f.store.task('memory')?.goal?.verificationRequired).toBeUndefined();
  f.client.onStart = async () => {
    await failure(f.call('delegate_work', {}), 'read-only');
    await failure(f.call('homie_ios_appium', {}), 'read-only');
    await f.call('record_decision', decision); f.client.complete('completed', 'Sourced memory summary'); return { turn: { id: 'turn' } };
  };
  f.agent.pump(); await f.agent.settled();
  expect(f.store.task('memory')).toMatchObject({ status: 'completed', goal: { verificationPolicy: readOnly } });
  const resume = f.client.calls.find(c => c.method === 'thread/resume')!.params;
  expect(resume.sandbox).toBe('read-only'); expect(record(resume.config)['features.shell_tool']).toBe(false);
  expect(f.client.calls.filter(c => c.method === 'turn/start').at(-1)!.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
});

test.each(['code_change', 'explicit'] as const)('%s requirements still reject self-reported completion without a verifier', async basis => {
  const f = fixture();
  const conversation = new WorkerConversation(f.store, true);
  f.store.create('strict', 'Independent review is required', { roomId: 'room', conversation: 'strict', dialogue: { userText: 'Independent review is required', questions: [], revisions: [] } });
  conversation.call(f.store.task('strict')!, 'start_goal', { objective: 'Review result', criteria, verification: { basis, reason: 'Original requirement' } });
  f.store.update('strict', { status: 'waiting' });
  f.client.onStart = async () => {
    await failure(f.call('record_decision', decision), 'verification');
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.pump(); await f.agent.settled();
  expect(f.store.task('strict')).toMatchObject({ status: 'interrupted', goal: { verificationRequired: true, verificationPolicy: { basis } } });
  const strict = { ...f.store.task('strict')!, inputs: [{ id: 'resume', prompt: 'Continue' }] };
  expect(() => reviewGoalVerification(strict, readOnly)).toThrow('unclassified');
});

test('legacy blocked goal resumes through user input, migrates tools, retains history, resets evidence and completes after rechecking', async () => {
  let f = fixture(); legacy(f);
  f = fixture(f.directory);
  expect(f.store.task('legacy')?.goal?.verificationRequired).toBe(true);
  const before = f.store.task('legacy')!;
  f.client.onStart = async () => {
    expect(f.store.task('legacy')?.goal?.verificationRequired).toBe(true);
    await f.call('review_goal_verification', { verification: readOnly });
    const reviewed = f.store.task('legacy')!;
    expect(reviewed.goal?.criteria).toEqual(criteria.map(criterion => ({ criterion, met: false, evidence: '' })));
    expect(reviewed.goal?.decisions).toEqual(before.goal!.decisions);
    expect(reviewed.status).not.toBe('completed');
    await f.call('record_decision', decision); f.client.complete('completed', 'Freshly checked summary'); return { turn: { id: 'turn' } };
  };
  f.agent.input('legacy', 'resume', 'Continue the original memory task and recheck the sources.', 'room'); await f.agent.settled();
  const saved = new AgentStore(f.directory).task('legacy')!;
  expect(saved).toMatchObject({ status: 'completed', previousThreadId: 'old-thread', goalPolicyTools: true,
    goal: { verificationPolicy: { ...readOnly, previousRequired: true, inputId: 'resume' }, turns: 2 } });
  expect(saved.goal!.decisions[0]).toEqual(before.goal!.decisions[0]);
  expect(saved.inputs).toHaveLength(1); expect(saved.activity?.slice(0, before.activity!.length)).toEqual(before.activity);
  expect(saved.activity?.at(-1)?.text).toBe('Freshly checked summary');
  const started = f.client.calls.find(c => c.method === 'thread/start')!.params;
  expect(JSON.stringify(started.dynamicTools)).toContain('review_goal_verification');
  const handover = JSON.stringify(f.client.calls.find(c => c.method === 'thread/inject_items')!.params);
  expect(handover).toContain('old-thread'); expect(handover).toContain('Prior sourced summary'); expect(handover).toContain('No commands');
  expect(f.client.calls.some(c => c.method === 'thread/resume')).toBe(false);
  f.agent.input('legacy', 'resume', 'Continue the original memory task and recheck the sources.', 'room'); await f.agent.settled();
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('failed legacy handover does not execute or weaken the goal, and retry keeps the saved original context', async () => {
  const f = fixture(); legacy(f);
  f.client.onInject = async () => { throw new Error('injection unavailable'); };
  f.agent.input('legacy', 'resume', 'Continue', 'room'); await f.agent.settled();
  expect(f.client.calls.some(c => c.method === 'turn/start')).toBe(false);
  expect(f.store.task('legacy')).toMatchObject({ status: 'failed', goal: { verificationRequired: true } });
  expect(f.store.snapshot().threads.legacy).toBe('old-thread');
  expect(f.store.task('legacy')?.output).toBe('Prior sourced summary');
  f.client.onInject = async () => ({});
  f.client.onStart = async () => {
    await f.call('review_goal_verification', { verification: readOnly });
    await f.call('record_decision', decision); f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.input('legacy', 'retry', 'Resume after the connection recovered', 'room'); await f.agent.settled();
  expect(f.store.task('legacy')?.status).toBe('completed');
  expect(JSON.stringify(f.client.calls.filter(c => c.method === 'thread/inject_items').at(-1)?.params)).toContain('Prior sourced summary');
});

test('a new room message can route to the legacy task after restart without creating a replacement goal', async () => {
  let f = fixture(); legacy(f);
  f.store.create('followup', 'Continue the memory task', { roomId: 'room', conversation: 'followup',
    dialogue: { userText: 'Continue the memory task', questions: [], revisions: [] } });
  new WorkerConversation(f.store, true).call(f.store.task('followup')!, 'continue_goal', { taskId: 'legacy', reason: 'Same original memory request' });
  f.store.update('followup', { status: 'completed' });
  f = fixture(f.directory);
  f.client.onStart = async () => {
    expect(f.store.task('legacy')?.inputs).toEqual([{ id: 'followup', prompt: 'Continue the memory task' }]);
    await f.call('review_goal_verification', { verification: readOnly });
    await f.call('record_decision', decision); f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.pump(); await f.agent.settled();
  expect(f.store.task('legacy')).toMatchObject({ status: 'completed', goal: { verificationPolicy: { inputId: 'followup', basis: 'read_only' } } });
  expect(f.store.task('followup')?.goal).toBeUndefined();
  expect(f.store.task('followup')?.dialogue?.route?.delivered).toBe(true);
  f.agent.pump(); await f.agent.settled();
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test.each(['file', 'command', 'unknown_tool', 'truncated', 'missing'] as const)('legacy %s evidence cannot silently become read-only completion', kind => {
  const f = fixture(); legacy(f, { inputs: [{ id: 'resume', prompt: 'Continue' }] });
  const task = f.store.task('legacy')!;
  if (kind === 'truncated') task.activityTruncated = true;
  else if (kind === 'missing') delete task.activity;
  else task.activity = [{ ...task.activity![0]!, kind: kind === 'unknown_tool' ? 'tool' : kind, title: 'unrecognized' }];
  expect(() => reviewGoalVerification(task, readOnly)).toThrow('independent verification');
  expect(task.goal?.verificationRequired).toBe(true);
});

test('policy parsing rejects malformed and inconsistent persistence, while legacy flags survive unchanged', () => {
  for (const value of [{ ...readOnly, previousRequired: 'true' }, { basis: 'automatic', reason: 'Claim' }, { ...readOnly, inputId: false }, { ...readOnly, reason: ' ' }]) {
    expect(() => parseGoalVerification(value)).toThrow();
  }
  expect(parseGoal(newGoal(true)).verificationRequired).toBe(true);
  expect(() => parseGoal({ ...newGoal(true), verificationPolicy: readOnly })).toThrow('Inconsistent');
  expect(parseGoal({ ...newGoal(), ...verificationFields(readOnly) }).verificationPolicy).toEqual(readOnly);
});

test('a user scope expansion can strengthen a direct policy but cannot weaken an independent policy', () => {
  const f = fixture(); legacy(f, { inputs: [{ id: 'change', prompt: 'Implement the fix and obtain independent review' }] });
  const task = f.store.task('legacy')!;
  task.goal = { ...task.goal!, ...verificationFields(readOnly) };
  const goal = reviewGoalVerification(task, { basis: 'code_change', reason: 'User now requests implementation' });
  expect(goal.verificationRequired).toBe(true);
  expect(() => reviewGoalVerification({ ...task, goal }, readOnly)).toThrow('unclassified');
});

const operational = { basis: 'operational' as const, reason: 'Read existing sessions using authorized tools; no code changes or independent review requested.' };
function correctionFor(task: Task) {
  return { inputId: task.inputs!.at(-1)!.id, originalRequest: task.dialogue!.userText, noIndependentReviewRequirement: true,
    actions: (task.activity ?? []).filter(a => a.kind === 'command' || a.title === 'homie_probe')
      .map(a => ({ id: a.id, evidence: 'Read the skill file or existing sessions only; no code changes.' })) };
}

test.each([true, false])('operational checks complete without peers; command permission remains %s and project writes remain disabled', async permitted => {
  const f = fixture(undefined, true, permitted);
  f.client.onStart = async () => {
    await f.call('start_goal', { objective: 'Read sessions', criteria, verification: operational });
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('probe', 'Read sessions', { roomId: 'room', conversation: 'probe', goal: false, automatic: true, userText: 'Read sessions' });
  await f.agent.settled();
  f.client.onStart = async () => {
    await failure(f.call('request_work', {}), 'Operational');
    await failure(f.call('request_execution_permissions', { fileWrite: true, commandExecution: false, reason: 'Write code' }), 'Upgrade');
    const operation = f.call('homie_probe');
    const request = f.queue.exchange({ protocol: 1, results: [] }).requests[0];
    if (permitted) {
      expect(request?.tool).toBe('homie_probe');
      f.queue.exchange({ protocol: 1, results: [{ id: request!.id, result: { ok: true, sessions: [] } }] });
      expect(await operation).toEqual({ ok: true, sessions: [] });
      await f.call('record_decision', decision);
    } else {
      expect(request).toBeUndefined(); await failure(operation, 'command permission');
      await f.call('record_decision', { ...decision, action: 'blocked', reason: 'Command permission missing' });
    }
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.pump(); await f.agent.settled();
  expect({ status: f.store.task('probe')?.status, error: f.store.task('probe')?.error }).toEqual({ status: permitted ? 'completed' : 'interrupted', error: permitted ? null : 'Command permission missing' });
  expect(f.store.task('probe')?.goal?.verificationRequired).toBeUndefined();
  const resume = f.client.calls.find(c => c.method === 'thread/resume')!.params;
  expect(record(resume.config)['features.shell_tool']).toBe(permitted);
  if (permitted) {
    const profile = record(record(resume.config)['permissions.cheshi-test-scratch']);
    expect(record(profile.filesystem)['/workspace']).toBe('read');
  } else expect(resume.sandbox).toBe('read-only');
});

test('a migrated capability-based legacy policy is reclassified with audited actions, keeps history, and completes only after fresh execution', async () => {
  let f = fixture(); legacy(f, { goalPolicyTools: true }, 'Read existing iOS sessions using tools. Do not create sessions or operate the device.');
  const task = f.store.task('legacy')!;
  const sessionCriteria = [{ criterion: 'Report the existing iOS sessions from the actual tool result', met: true, evidence: 'The session probe returned ok:true and sessions:[].' }];
  const sessionDecision = { ...decision, criteria: sessionCriteria, reason: 'Session query succeeded', progress: 'Reported the observed empty session list' };
  const activity = [
    { ...task.activity![0]!, id: 'read-skill', kind: 'command' as const, title: 'cat SKILL.md', text: 'Skill instructions' },
    { ...task.activity![0]!, id: 'sessions', title: 'homie_probe', text: '{"ok":true,"sessions":[]}' },
  ];
  f.store.update('legacy', { activity, goal: { ...task.goal!, criteria: sessionCriteria,
    decisions: [{ ...sessionDecision, action: 'blocked', reason: 'Old capability policy requires independent verification' }], ...verificationFields({ basis: 'explicit',
    reason: 'The old policy requires independent verification to enable custom tools.', previousRequired: true, inputId: 'earlier' }) } });
  f = fixture(f.directory, false, true);
  let turns = 0;
  f.client.onStart = async () => {
    turns++;
    if (turns === 1) {
      const before = f.store.task('legacy')!;
      await f.call('review_goal_verification', { verification: operational, correction: correctionFor(before) });
      expect(f.store.task('legacy')?.goal?.criteria.every(c => !c.met && !c.evidence)).toBe(true);
      expect(f.store.task('legacy')?.goal?.decisions).toEqual(before.goal!.decisions);
      await f.call('record_decision', { ...sessionDecision, action: 'continue', nextAction: 'Read sessions with the reviewed policy' });
    } else {
      const operation = f.call('homie_probe');
      const request = f.queue.exchange({ protocol: 1, results: [] }).requests[0]!;
      f.queue.exchange({ protocol: 1, results: [{ id: request.id, result: { ok: true, sessions: [] } }] });
      expect(await operation).toEqual({ ok: true, sessions: [] });
      await f.call('record_decision', sessionDecision);
    }
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.input('legacy', 'correct-policy', 'Continue the original session check and correct the tool-based classification.', 'room');
  await f.agent.settled(); f.agent.pump(); await f.agent.settled();
  const saved = new AgentStore(f.directory).task('legacy')!;
  expect(saved).toMatchObject({ status: 'completed', previousThreadId: 'old-thread', goalPolicyVersion: 2,
    goal: { verificationPolicy: { ...operational, version: 2, previousRequired: true, inputId: 'correct-policy' } } });
  expect(saved.activity!.slice(0, activity.length)).toEqual(activity);
  expect(saved.goal?.decisions[0]?.reason).toBe('Old capability policy requires independent verification');
  expect(f.client.calls.filter(c => c.method === 'thread/start')).toHaveLength(1);
  expect(f.client.calls.filter(c => c.method === 'thread/resume')).toHaveLength(1);
  expect(JSON.stringify(f.client.calls.find(c => c.method === 'thread/start')!.params.dynamicTools)).toContain('operational');
});

test.each(['file', 'truncated', 'entry_truncated', 'missing', 'unknown', 'missing_action', 'wrong_input', 'wrong_request', 'false_attestation', 'same_input', 'explicit_v2', 'code_change'] as const)(
  'operational reclassification rejects %s evidence without changing persisted requirements', kind => {
    const f = fixture(); legacy(f, { inputs: [{ id: 'resume', prompt: 'Recheck the old classification' }] });
    const task = f.store.task('legacy')!;
    task.goal = { ...task.goal!, ...verificationFields({ basis: 'explicit', reason: 'Legacy retained requirement', previousRequired: true, inputId: 'prior' }) };
    task.activity = [{ ...task.activity![0]!, kind: 'command', title: 'cat SKILL.md' }];
    const correction = correctionFor(task);
    if (kind === 'file') task.activity![0]!.kind = 'file';
    if (kind === 'truncated') task.activityTruncated = true;
    if (kind === 'entry_truncated') task.activity![0]!.truncated = true;
    if (kind === 'missing') delete task.activity;
    if (kind === 'unknown') task.activity![0]!.status = 'unknown';
    if (kind === 'missing_action') correction.actions = [];
    if (kind === 'wrong_input') correction.inputId = 'invented';
    if (kind === 'same_input') task.goal.verificationPolicy!.inputId = 'resume';
    if (kind === 'wrong_request') correction.originalRequest = 'Invented original request';
    if (kind === 'false_attestation') correction.noIndependentReviewRequirement = false;
    if (kind === 'explicit_v2') task.goal.verificationPolicy!.version = 2;
    if (kind === 'code_change') task.goal.verificationPolicy!.basis = 'code_change';
    expect(() => reviewGoalVerification(task, operational, correction)).toThrow();
    expect(task.goal.verificationRequired).toBe(true);
  });

test('code changes cannot be hidden behind an operational completion, including changes arriving after a decision', async () => {
  for (const late of [false, true]) {
    const f = fixture(); legacy(f);
    const task = f.store.task('legacy')!;
    f.store.update('legacy', { goal: { ...task.goal!, ...verificationFields({ ...operational, version: 2 }), phase: 'ready' }, status: 'waiting' });
    f.client.onStart = async () => {
      const changed = () => f.store.update('legacy', { activity: [{ ...task.activity![0]!, kind: 'file', title: 'File changes' }] });
      if (late) { await f.call('record_decision', decision); changed(); }
      else { changed(); await failure(f.call('record_decision', decision), 'independent verification'); }
      f.client.complete(); return { turn: { id: 'turn' } };
    };
    f.agent.pump(); await f.agent.settled();
    expect(f.store.task('legacy')?.status).not.toBe('completed');
  }
});

test.each([false, true])('a clipped MCP resource-list response preserves the reviewable legacy history (optional receipt audit: %s)', auditList => {
  const f = fixture(); legacy(f, { inputs: [{ id: 'resume', prompt: 'Review the old session-query policy' }] }, 'Read existing sessions only.');
  const task = f.store.task('legacy')!;
  task.goal = { ...task.goal!, ...verificationFields({ basis: 'explicit', reason: 'Legacy tools required this policy', previousRequired: true, inputId: 'prior' }) };
  const base = task.activity![0]!;
  task.activity = [
    { ...base, id: 'resources', title: 'codex · list_mcp_resources', text: '{"resources":[…', truncated: true },
    { ...base, id: 'read-skill', kind: 'command', title: 'cat SKILL.md', text: 'Skill content' },
    { ...base, id: 'sessions', title: 'homie_probe', text: '{"ok":true,"sessions":[]}' },
  ];
  const correction = correctionFor(task);
  if (auditList) correction.actions.push({ id: 'resources', evidence: 'Only the returned resource catalog was clipped; no code changes.' });
  const goal = reviewGoalVerification(task, operational, correction);
  expect(goal.verificationRequired).toBeUndefined();
  expect(goal.criteria.every(c => !c.met && !c.evidence)).toBe(true);
  expect(goal.decisions).toEqual(task.goal.decisions);
  expect(parseGoal(goal).verificationPolicy?.correction?.actions).toEqual(correction.actions);
  task.activityTruncated = true;
  expect(() => reviewGoalVerification(task, operational, correction)).toThrow('incomplete execution history');
});

test.each(['homie_probe', 'other_server · list_mcp_resources', 'codex · list_mcp_resources_extra'])('a clipped unrecognized tool response cannot use the catalog exception: %s', title => {
  const f = fixture(); legacy(f, { inputs: [{ id: 'resume', prompt: 'Continue' }] });
  const task = f.store.task('legacy')!;
  task.activity![0] = { ...task.activity![0]!, title, truncated: true };
  expect(() => reviewGoalVerification(task, operational, correctionFor(task))).toThrow('incomplete execution history');
});

test('correction evidence cannot reference an invented action', () => {
  const f = fixture(); legacy(f, { inputs: [{ id: 'resume', prompt: 'Continue' }] });
  const task = f.store.task('legacy')!, correction = correctionFor(task);
  correction.actions.push({ id: 'invented', evidence: 'Claimed receipt' });
  expect(() => reviewGoalVerification(task, operational, correction)).toThrow('Review every recorded');
});
