import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { newGoal } from './decision.ts';
import { WorkerVerification, snapshotArtifacts } from './verification.ts';
import { assertResult, verificationRequest, verificationResult, type VerificationResult } from './verification-contract.ts';
import type { CollaborationMessage } from './collaboration-contract.ts';

const roots: string[] = [];
const roster = [{ id: 'dev', name: 'Dev', role: 'development' }, { id: 'reviewer', name: 'Reviewer', role: 'verification' }];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-verification-')); roots.push(root);
  writeFileSync(join(root, 'login.ts'), 'export const valid = true;');
  const store = new AgentStore(join(root, 'dev')), reviewer = new AgentStore(join(root, 'reviewer'));
  const owner = new WorkerCollaboration(store, 'dev', root), peer = new WorkerCollaboration(reviewer, 'reviewer', root);
  const verifier = new WorkerVerification(reviewer, root);
  owner.exchange({ peers: roster, messages: [], acknowledged: [] });
  store.create('login', 'Implement and verify login.', { goal: newGoal(true) });
  const request = (requestId = 'round1') => {
    owner.call(store.task('login')!, 'request_verification', { agentId: 'reviewer', requestId, criteria: ['Login is correct'], paths: ['login.ts'] });
    const message = store.snapshot().collaboration.outgoing.at(-1)!;
    peer.exchange({ peers: roster, messages: [message], acknowledged: [] });
    const next = peer.next()!;
    reviewer.create(next.taskId, next.prompt, { verification: next.verification });
    return { message, taskId: next.taskId };
  };
  return { root, store, reviewer, owner, peer, verifier, request };
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function observe(f: ReturnType<typeof setup>, taskId: string, exitCode = 0) {
  const item = { id: 'native-check', type: 'commandExecution', command: 'bun test login.test.ts', status: 'completed', exitCode, aggregatedOutput: exitCode ? 'assertion failed' : '1 pass' };
  f.verifier.observe(f.reviewer.task(taskId)!, 'item/started', item);
  f.verifier.observe(f.reviewer.task(taskId)!, 'item/completed', item);
}
function draft(f: ReturnType<typeof setup>, taskId: string, verdict: 'pass' | 'fail' = 'pass') {
  f.verifier.call(f.reviewer.task(taskId)!, 'verification_read', { path: 'login.ts' });
  const evidenceIds = f.reviewer.task(taskId)!.verificationEvidence!.map(e => e.id);
  f.verifier.call(f.reviewer.task(taskId)!, 'submit_verification', { verdicts: [{ criterion: 'Login is correct', verdict, reason: 'Observed native check and file.', evidenceIds }] });
}
function deliver(f: ReturnType<typeof setup>, taskId: string) {
  f.peer.publishVerification(f.reviewer.task(taskId)!, f.verifier.finish(f.reviewer.task(taskId)!));
  const result = f.reviewer.snapshot().collaboration.outgoing.at(-1)!;
  f.owner.exchange({ peers: roster, messages: [result], acknowledged: [] });
  return result;
}

test('ordinary verification delivers more than 12k of evidence and retains all 64 native receipts', () => {
  const f = setup(), { taskId } = f.request();
  f.verifier.call(f.reviewer.task(taskId)!, 'verification_read', { path: 'login.ts' });
  const observeCommand = (index: number) => {
    const item = { id: `check-${index}`, type: 'commandExecution', command: `bun test check-${index}.test.ts`,
      status: 'completed', exitCode: 0, aggregatedOutput: 'verified output '.repeat(70) };
    f.verifier.observe(f.reviewer.task(taskId)!, 'item/started', item);
    f.verifier.observe(f.reviewer.task(taskId)!, 'item/completed', item);
  };
  for (let index = 0; index < 63; index++) observeCommand(index);
  const evidence = f.reviewer.task(taskId)!.verificationEvidence!;
  expect(evidence).toHaveLength(64);
  expect(() => observeCommand(63)).toThrow('Verification evidence limit reached');
  expect(f.reviewer.task(taskId)!.verificationEvidence).toEqual(evidence);
  f.verifier.call(f.reviewer.task(taskId)!, 'submit_verification', { verdicts: [{ criterion: 'Login is correct',
    verdict: 'pass', reason: 'Observed file and successful native commands.', evidenceIds: [evidence[0]!.id, evidence[1]!.id] }] });
  const result = deliver(f, taskId);
  expect(result.text.length).toBeGreaterThan(12_000);
  expect(verificationResult(JSON.parse(result.text)).evidence).toEqual(evidence);
  f.owner.assertVerified(f.store.task('login')!, [result.id]);
});

test('independent pass needs observed file and command receipts, survives restart, and becomes stale after an edit', () => {
  const f = setup(), { taskId } = f.request();
  expect(() => f.owner.assertVerified(f.store.task('login')!)).toThrow('processed');
  observe(f, taskId); draft(f, taskId);
  const result = deliver(f, taskId);
  expect(() => f.owner.assertVerified(f.store.task('login')!)).toThrow('processed');
  f.owner.assertVerified(f.store.task('login')!, [result.id]);
  f.store.complete('login', { status: 'waiting', output: 'Review received', error: null }, [result.id]);
  const restored = new AgentStore(join(f.root, 'dev'));
  new WorkerCollaboration(restored, 'dev', f.root).assertVerified(restored.task('login')!);
  writeFileSync(join(f.root, 'login.ts'), 'export const valid = false;');
  expect(() => f.owner.assertVerified(f.store.task('login')!, [result.id])).toThrow('changed');
});

test('failed checks cannot support a pass; corrected files require a new verification round', () => {
  const f = setup(), first = f.request(); observe(f, first.taskId, 1);
  expect(() => draft(f, first.taskId)).toThrow('successful command');
  draft(f, first.taskId, 'fail'); const failed = deliver(f, first.taskId);
  expect(() => f.owner.assertVerified(f.store.task('login')!, [failed.id])).toThrow('did not pass');
  writeFileSync(join(f.root, 'login.ts'), 'export const valid = "fixed";');
  const second = f.request('round2');
  expect(() => f.owner.assertVerified(f.store.task('login')!, [failed.id])).toThrow('processed');
  observe(f, second.taskId); draft(f, second.taskId); const passed = deliver(f, second.taskId);
  f.owner.assertVerified(f.store.task('login')!, [failed.id, passed.id]);
});

test('pending verifier draft and runtime receipts persist but no unconfirmed result is sent', () => {
  const f = setup(), { taskId } = f.request(); observe(f, taskId); draft(f, taskId);
  expect(f.reviewer.snapshot().collaboration.outgoing).toHaveLength(0);
  const restored = new AgentStore(join(f.root, 'reviewer'));
  expect(restored.task(taskId)?.status).toBe('unknown');
  expect(restored.task(taskId)?.verificationDraft?.verdicts[0]?.verdict).toBe('pass');
  expect(restored.task(taskId)?.verificationEvidence).toHaveLength(2);
  expect(new WorkerCollaboration(restored, 'reviewer', f.root).next()).toBeNull();
});

test('missing receipts, fabricated IDs and changed snapshots cannot pass', () => {
  const f = setup(), { taskId } = f.request();
  expect(() => draft(f, taskId)).toThrow('successful command');
  expect(() => f.verifier.call(f.reviewer.task(taskId)!, 'submit_verification', { verdicts: [{ criterion: 'Login is correct', verdict: 'pass', reason: 'Claim', evidenceIds: ['invented'] }] })).toThrow('Unknown evidence');
  observe(f, taskId); draft(f, taskId);
  writeFileSync(join(f.verifier.workspaceFor(f.reviewer.task(taskId)!), 'login.ts'), 'changed');
  expect(f.verifier.finish(f.reviewer.task(taskId)!).verdicts[0]?.verdict).toBe('inconclusive');
});

test('rejects traversal, symlink, oversized files, self-review and criteria replacement', () => {
  const f = setup();
  createSymbolicLink(join(f.root, 'login.ts'), join(f.root, 'link.ts'));
  writeFileSync(join(f.root, 'large.ts'), 'x'.repeat(65_537));
  for (const path of ['../login.ts', '/etc/passwd', 'link.ts', 'large.ts']) expect(() => snapshotArtifacts(f.root, [path])).toThrow();
  const args = { agentId: 'dev', requestId: 'self', criteria: ['Login is correct'], paths: ['login.ts'] };
  expect(() => f.owner.call(f.store.task('login')!, 'request_verification', args)).toThrow('independent');
  const { taskId } = f.request(); observe(f, taskId); draft(f, taskId); deliver(f, taskId);
  expect(() => f.owner.call(f.store.task('login')!, 'request_verification', { ...args, agentId: 'reviewer', criteria: ['Weaker criterion'] })).toThrow('original');
});

test('duplicate delivery is idempotent; foreign, conflicting and second results are rejected', () => {
  const f = setup(), { taskId } = f.request(); observe(f, taskId); draft(f, taskId); const result = deliver(f, taskId);
  f.owner.exchange({ peers: roster, messages: [result], acknowledged: [] });
  expect(f.store.snapshot().collaboration.incoming).toHaveLength(1);
  for (const patch of [{ from: 'foreign' }, { id: 'second' }, { taskId: 'other' }]) {
    expect(() => f.owner.exchange({ peers: roster, messages: [{ ...result, ...patch }], acknowledged: [] })).toThrow();
  }
});

test('canceled owners retain verification results without waking and malformed persisted results fail closed', () => {
  const f = setup(), { taskId } = f.request();
  f.store.complete('login', { status: 'interrupted', output: 'Canceled', error: null });
  observe(f, taskId); draft(f, taskId); deliver(f, taskId);
  expect(f.owner.next()).toBeNull();
  expect(() => verificationResult({ verdicts: [], evidence: [] })).toThrow();
  const request = verificationRequest(JSON.parse(f.store.snapshot().collaboration.outgoing[0]!.text));
  const wrong: VerificationResult = { verdicts: [{ criterion: 'Other', verdict: 'inconclusive', reason: 'unknown', evidenceIds: [] }], evidence: [] };
  expect(() => assertResult(request, wrong)).toThrow('original');
});

test('a pending request survives restart and acknowledged requests still count as waiting', () => {
  const f = setup(), { message } = f.request();
  f.store.complete('login', { status: 'waiting', output: 'Await review', error: null, goal: { ...f.store.task('login')!.goal!, phase: 'waiting' } });
  const restored = new AgentStore(join(f.root, 'dev')), owner = new WorkerCollaboration(restored, 'dev', f.root);
  owner.exchange({ peers: roster, messages: [], acknowledged: [message.id] });
  expect(owner.waiting('login')).toBe(true);
  const bad: CollaborationMessage = { ...message, id: 'foreign', questionId: 'missing', kind: 'verification_result', from: 'reviewer', to: 'dev', text: JSON.stringify({ verdicts: [{ criterion: 'Login is correct', verdict: 'inconclusive', reason: 'unknown', evidenceIds: [] }], evidence: [] }) };
  expect(() => owner.exchange({ peers: roster, messages: [bad], acknowledged: [] })).toThrow('Unsolicited');
});

test('native failed command status preserves its actual exit code without treating it as successful', () => {
  const f = setup(), { taskId } = f.request(), task = f.reviewer.task(taskId)!;
  const item = { type: 'commandExecution', id: 'failed-native', command: 'bun test', status: 'failed', exitCode: 1, aggregatedOutput: '1 fail' };
  f.verifier.observe(task, 'item/started', item); f.verifier.observe(task, 'item/completed', item);
  expect(f.reviewer.task(taskId)?.verificationEvidence).toMatchObject([{ exitCode: 1, successful: false }]);
  expect(() => draft(f, taskId)).toThrow('successful command');
});
