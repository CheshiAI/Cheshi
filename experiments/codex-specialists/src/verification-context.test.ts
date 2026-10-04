import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { newGoal } from './decision.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { message, type CollaborationMessage } from './collaboration-contract.ts';
import { WorkerVerification } from './verification.ts';
import { VERIFICATION_CONTEXT_LIMIT, verificationRequest, type VerificationContext, type VerificationResult } from './verification-contract.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const peers = [{ id: 'owner', name: 'Dev', role: 'development' }, { id: 'verifier', name: 'QA', role: 'verification' }];
const rooms = { room: ['owner', 'verifier'], other: ['owner', 'verifier'] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-verification-context-')); roots.push(root);
  writeFileSync(join(root, 'login.ts'), 'broken'); writeFileSync(join(root, 'test.ts'), 'fixed acceptance tests');
  const store = new AgentStore(join(root, 'owner')), reviewer = new AgentStore(join(root, 'verifier'));
  const owner = new WorkerCollaboration(store, 'owner', root), peer = new WorkerCollaboration(reviewer, 'verifier', root);
  const verifier = new WorkerVerification(reviewer, root);
  owner.exchange({ peers, rooms, messages: [], acknowledged: [] });
  store.create('goal', 'Repair login; keep tests unchanged', { roomId: 'room', goal: newGoal(true),
    dialogue: { userText: 'Repair login', questions: [], revisions: [] } });
  const args = (requestId: string) => ({ agentId: 'verifier', requestId, criteria: ['Login works'], paths: ['login.ts', 'test.ts'] });
  const request = (requestId: string) => {
    const result = owner.call(store.task('goal')!, 'request_verification', args(requestId));
    return store.snapshot().collaboration.outgoing.find(m => m.id === result.requestId)!;
  };
  const failed = (request: CollaborationMessage) => {
    const spec = verificationRequest(JSON.parse(request.text));
    const result: VerificationResult = { verdicts: spec.criteria.map(criterion => ({ criterion, verdict: 'fail', reason: 'Empty password accepted', evidenceIds: ['failed-command'] })),
      evidence: [{ id: 'failed-command', kind: 'command', detail: 'node --test test.ts', output: 'Expected false; actual true', exitCode: 1, successful: false }] };
    const reply: CollaborationMessage = { ...request, id: `result_${request.id.slice(0, 40)}`, kind: 'verification_result', from: 'verifier', to: 'owner', text: JSON.stringify(result) };
    owner.exchange({ peers, rooms, messages: [reply], acknowledged: [] });
    return reply;
  };
  return { root, store, reviewer, owner, peer, verifier, args, request, failed };
}
const context = (m: CollaborationMessage) => verificationRequest(JSON.parse(m.text)).context!;

test('re-verification carries actual user answers, baseline hashes and native failed receipts through delivery and restart', () => {
  const f = fixture(), first = f.request('first'), reply = f.failed(first);
  const task = f.store.task('goal')!;
  f.store.update(task.id, { inputs: [{ id: 'answer', prompt: 'Reject empty domain labels only.' }],
    dialogue: { ...task.dialogue!, questions: [{ id: 'scope', text: 'Which email cases?', answer: { id: 'answer', text: 'Reject empty domain labels only.' } }] } });
  writeFileSync(join(f.root, 'login.ts'), 'fixed');
  const second = f.request('second'), c = context(second);
  expect(c.baseline).toEqual({ requestId: first.id, artifacts: verificationRequest(JSON.parse(first.text)).artifacts });
  expect(c.inputs).toEqual([{ id: 'answer', text: 'Reject empty domain labels only.', question: { id: 'scope', text: 'Which email cases?' } }]);
  expect(c.rounds[0]).toMatchObject({ requestId: first.id, resultId: reply.id, verifierId: 'verifier', superseded: false,
    result: { verdicts: [{ verdict: 'fail' }], evidence: [{ exitCode: 1, successful: false }] } });
  expect(c.rounds[0]!.artifacts[0]!.sha256).not.toBe(verificationRequest(JSON.parse(second.text)).artifacts[0]!.sha256);
  expect(c.rounds[0]!.artifacts[1]).toEqual(verificationRequest(JSON.parse(second.text)).artifacts[1]);
  f.peer.exchange({ peers, rooms, messages: [second], acknowledged: [] });
  const next = f.peer.next()!;
  expect(next.prompt).toContain('Reject empty domain labels only.');
  const verification = f.reviewer.create(next.taskId, next.prompt, { roomId: 'room', verification: next.verification });
  const restored = new AgentStore(f.reviewer.directory), verifier = new WorkerVerification(restored, f.root);
  expect(verifier.call(restored.task(verification.id)!, 'verification_status', {})).toMatchObject({ request: { context: c }, evidence: [] });
  // Past command receipts cannot be offered as current verification evidence.
  expect(() => verifier.call(restored.task(verification.id)!, 'submit_verification', { verdicts: [{ criterion: 'Login works', verdict: 'pass', reason: 'Old command', evidenceIds: ['failed-command'] }] })).toThrow('Unknown evidence');
});

test('runtime ignores invented tool context and excludes other goals, rooms, recipients and unbacked answers', () => {
  const f = fixture(), first = f.request('first'), reply = f.failed(first);
  f.store.transaction(state => {
    state.tasks.push({ ...state.tasks[0]!, id: 'foreign', inputs: [{ id: 'secret', prompt: 'OTHER GOAL' }] });
    for (const [suffix, patch] of [['task', { taskId: 'foreign' }], ['room', { roomId: 'other' }], ['owner', { from: 'foreign' }]] as const) {
      state.collaboration.outgoing.push({ ...first, ...patch, id: suffix, questionId: suffix });
      state.collaboration.incoming.push({ ...reply, id: `reply_${suffix}`, questionId: suffix, ...patch });
    }
    state.tasks[0]!.dialogue!.questions.push({ id: 'invented', text: 'fake', answer: { id: 'missing', text: 'FABRICATED' } });
  });
  f.owner.call(f.store.task('goal')!, 'request_verification', { ...f.args('second'), context: { inputs: [{ id: 'fake', text: 'FABRICATED' }] } });
  const second = f.store.snapshot().collaboration.outgoing.at(-1)!, c = context(second);
  expect(c.inputs).toEqual([]); expect(c.rounds.map(r => r.requestId)).toEqual([first.id]);
  for (const patch of [{ ownerId: 'foreign' }, { taskId: 'foreign' }, { roomId: 'other' }]) {
    expect(() => message({ ...second, text: JSON.stringify({ ...verificationRequest(JSON.parse(second.text)), context: { ...c, ...patch } }) })).toThrow('another goal or room');
  }
});

test('retry retains its saved context after new inputs, while changed artifacts or criteria still conflict', () => {
  const f = fixture(), first = f.request('first'); f.failed(first);
  f.store.update('goal', { inputs: [{ id: 'later', prompt: 'Later clarification' }] });
  expect(f.request('first')).toEqual(first);
  writeFileSync(join(f.root, 'login.ts'), 'changed');
  expect(() => f.request('first')).toThrow('different content');
  expect(() => f.owner.call(f.store.task('goal')!, 'request_verification', { ...f.args('new'), criteria: ['Weaker'] })).toThrow('original');
});

test('bounded context keeps the first hashes and recent rounds without nesting contexts, with explicit omissions', () => {
  const f = fixture(); let first: CollaborationMessage | undefined;
  for (let i = 0; i < 6; i++) { const m = f.request(`round${i}`); first ??= m; f.failed(m); }
  f.store.update('goal', { inputs: Array.from({ length: 10 }, (_, i) => ({ id: `input${i}`, prompt: 'x'.repeat(16_000) })) });
  const last = f.request('last'), c = context(last);
  expect(c.baseline?.requestId).toBe(first!.id);
  expect(c.omittedRounds + c.rounds.length).toBe(6);
  expect(c.omittedInputs + c.inputs.length).toBe(10);
  expect(c.omittedRounds).toBeGreaterThan(0); expect(c.omittedInputs).toBeGreaterThan(0);
  expect(c.inputs.at(-1)?.id).toBe('input9');
  expect(JSON.stringify(c).length).toBeLessThanOrEqual(VERIFICATION_CONTEXT_LIMIT);
  expect(JSON.stringify(c.rounds)).not.toContain('"context"');
});

test('legacy requests remain readable and malformed history cannot fabricate a pass', () => {
  const f = fixture(), first = f.request('first'); f.failed(first);
  const spec = verificationRequest(JSON.parse(f.request('second').text));
  const { context: _, ...legacy } = spec;
  expect(verificationRequest(legacy).context).toBeUndefined();
  const c = structuredClone(spec.context!) as VerificationContext;
  c.rounds[0]!.result.verdicts[0]!.verdict = 'pass';
  expect(() => verificationRequest({ ...spec, context: c })).toThrow('successful command');
  expect(() => verificationRequest({ ...spec, context: { ...spec.context, omittedInputs: true } })).toThrow('context');
});

test('a requirement revision marks historical rounds superseded without replacing their original criteria', () => {
  const f = fixture(), first = f.request('first'); f.failed(first);
  const t = f.store.task('goal')!;
  f.store.update('goal', { dialogue: { ...t.dialogue!, revisions: [{ inputId: 'revision', source: 'New scope', reason: 'User clarification', before: ['Login works'], after: ['Login works'], invalidated: [first.id] }] } });
  expect(context(f.request('second')).rounds[0]).toMatchObject({ superseded: true, criteria: ['Login works'] });
});
