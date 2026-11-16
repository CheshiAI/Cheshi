import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateFixture } from './candidate-verification-fixture.ts';
import { AgentStore } from './store.ts';
import { WorkerVerification } from './verification.ts';
import { WorkerIntegration } from './integration.ts';
import { assertResult, verificationRequest, verificationResult } from './verification-contract.ts';
import { assertCandidate, candidateSnapshot } from './candidate-verification-contract.ts';
import { workDigest } from './work-files.ts';
import { parseRuntimeConfiguration } from './runtime-config.ts';
import type { RecoveryReceipt } from './recovery.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(count?: number) {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-candidate-verification-')); directories.push(root);
  return candidateFixture(root, count);
}
const receipt: RecoveryReceipt = { threadId: 'thread', turnId: 'turn', status: 'completed', checkedAt: '2026-10-04T00:00:00.000Z' };

test('full candidate verification includes deletions, binds identity and survives restart without applying source', () => {
  const f = fixture(), { taskId, cwd } = f.requestVerification();
  expect(cwd).not.toBe(f.project); expect(f.inspect().verification?.status).toBe('pending');
  expect(f.reviewer.task(taskId)?.prompt).not.toContain('candidate file-00.txt');
  expect(readFileSync(join(cwd, f.paths[0]!), 'utf8')).toBe(`candidate ${f.paths[0]}`);
  expect(f.verifier.call(f.reviewer.task(taskId)!, 'verification_read', { path: f.paths[1] }).content).toBeNull();
  f.observe(taskId);
  // Select a native command and file receipt, regardless of prior reads.
  for (const path of f.paths) f.verifier.call(f.reviewer.task(taskId)!, 'verification_read', { path });
  const evidence = f.reviewer.task(taskId)!.verificationEvidence!;
  f.verifier.call(f.reviewer.task(taskId)!, 'submit_verification', { candidate: { id: 'forged' }, verdicts: [{ criterion: f.args.criteria[0], verdict: 'pass', reason: 'Observed candidate', evidenceIds: evidence.map(e => e.id) }] });
  const restored = new AgentStore(f.reviewer.directory), verifier = new WorkerVerification(restored, f.project);
  expect(restored.task(taskId)?.status).toBe('unknown');
  const result = verifier.recover(restored.task(taskId)!, receipt);
  expect(result.candidate).toEqual({ id: f.candidate.id, hash: f.candidate.hash });
  expect(result.verdicts[0]?.verdict).toBe('pass');
  const message = f.deliver(taskId);
  expect(f.inspect().verification?.status).toBe('pass');
  const owner = new AgentStore(f.store.directory);
  expect(new WorkerIntegration(owner, f.project, 'owner', true).inspect(owner.task('goal')!)?.verification?.status).toBe('pass');
  expect(() => f.owner.assertVerified(f.store.task('goal')!, [message.id])).toThrow('project application');
  for (const path of f.paths) expect(readFileSync(join(f.project, path), 'utf8')).toBe(`original ${path}`);
  writeFileSync(join(f.project, f.paths[0]!), 'user edit');
  expect(f.inspect().verification?.status).toBe('stale');
  expect(() => f.integration.snapshot(f.store.task('goal')!)).toThrow('current, intact');
});

test.each(['fail', 'inconclusive'] as const)('candidate %s remains separate from successful execution', verdict => {
  const f = fixture(), { taskId } = f.requestVerification();
  f.observe(taskId, verdict === 'fail' ? 1 : 0); f.draft(taskId, verdict); f.deliver(taskId);
  expect(f.inspect().verification?.status).toBe(verdict);
});

test('an ended native turn without a confirmed draft cannot pass candidate verification', () => {
  const f = fixture(), { taskId } = f.requestVerification();
  f.observe(taskId);
  expect(f.verifier.recover(f.reviewer.task(taskId)!, receipt).verdicts[0]?.verdict).toBe('inconclusive');
});

test.each(['missing', 'changed', 'extra', 'absent-created'] as const)('recovery refuses %s verification copies without reconstructing them', kind => {
  const f = fixture(), { taskId, cwd } = f.requestVerification(); f.observe(taskId); f.draft(taskId);
  if (kind === 'missing') rmSync(cwd, { recursive: true });
  else writeFileSync(join(cwd, kind === 'extra' ? 'extra.txt' : f.paths[kind === 'absent-created' ? 1 : 0]!), 'changed');
  const restored = new AgentStore(f.reviewer.directory), verifier = new WorkerVerification(restored, f.project);
  expect(verifier.recoveryWorkspace(restored.task(taskId)!)).toBe(cwd);
  expect(verifier.recover(restored.task(taskId)!, receipt).verdicts[0]?.verdict).toBe('inconclusive');
  expect(verifier.finish(restored.task(taskId)!).verdicts[0]?.verdict).toBe('inconclusive');
  if (kind === 'missing') expect(existsSync(cwd)).toBe(false);
});

test('tampering during a command cannot produce a successful receipt or pass', () => {
  const f = fixture(), { taskId, cwd } = f.requestVerification();
  const item = { id: 'check', type: 'commandExecution', command: 'check', status: 'completed', exitCode: 0 };
  f.verifier.observe(f.reviewer.task(taskId)!, 'item/started', item);
  writeFileSync(join(cwd, f.paths[0]!), 'changed');
  f.verifier.observe(f.reviewer.task(taskId)!, 'item/completed', item);
  expect(f.reviewer.task(taskId)?.verificationEvidence).toBeUndefined();
  expect(() => f.draft(taskId)).toThrow();
});

test('missing commands, partial scope, author review and original-project fallback are refused', () => {
  const f = fixture();
  expect(() => f.owner.call(f.store.task('goal')!, 'request_verification', f.args)).toThrow('candidate');
  expect(() => f.owner.call(f.store.task('goal')!, 'request_verification', { ...f.args, paths: f.paths.slice(0, 1) }, f.candidate)).toThrow('every');
  expect(() => f.owner.call(f.store.task('goal')!, 'request_verification', { ...f.args, agentId: 'author' }, f.candidate)).toThrow('did not author');
  const { taskId } = f.requestVerification();
  expect(() => f.draft(taskId)).toThrow('successful command');
});

test('candidate ID/hash mismatch cannot be delivered as a result or reused by another prepared candidate', () => {
  const f = fixture(), { taskId, message } = f.requestVerification(); f.observe(taskId); f.draft(taskId);
  const result = f.verifier.finish(f.reviewer.task(taskId)!);
  for (const patch of [{ id: '0'.repeat(64) }, { hash: '0'.repeat(64) }]) {
    expect(() => assertResult(verificationRequest(JSON.parse(message.text)), { ...result, candidate: { ...result.candidate!, ...patch } })).toThrow('another candidate');
  }
  f.deliver(taskId);
  f.integration.call(f.store.task('goal')!, 'prepare_integration', { requestId: 'new-candidate', requestIds: f.candidate.requestIds });
  expect(f.inspect().verification).toBeUndefined();
  expect(f.inspect().id).not.toBe(f.candidate.id);
});

test('32-file candidates retain every receipt through durable state and result parsing', () => {
  const f = fixture(32), { taskId } = f.requestVerification(); f.observe(taskId); f.draft(taskId);
  const store = new AgentStore(f.reviewer.directory);
  expect(store.task(taskId)?.verificationEvidence).toHaveLength(33);
  expect(verificationResult(store.task(taskId)?.verificationDraft).evidence).toHaveLength(33);
  f.deliver(taskId); expect(f.inspect().verification?.status).toBe('pass');
});

test('candidate hashes, scope and runtime capability are validated', () => {
  const f = fixture();
  const forged = candidateSnapshot({ ...f.candidate, files: f.candidate.files.map((file, i) => i ? file : { ...file, content: 'forged' }) });
  expect(() => assertCandidate(forged, workDigest)).toThrow();
  expect(() => candidateSnapshot({ ...f.candidate, files: [{ path: '../escape', content: null, sha256: null }] })).toThrow();
  const config = { profileId: 'owner', accountId: 'account', role: 'development', token: 'a'.repeat(64), instructions: 'Implement',
    model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: true, commandExecution: false }, workProtocol: 1, integrationProtocol: 1, decisionProtocol: 1, verificationProtocol: 1, candidateVerificationProtocol: 1 };
  expect(parseRuntimeConfiguration(config).candidateVerificationProtocol).toBe(1);
  for (const patch of [{ candidateVerificationProtocol: true }, { integrationProtocol: undefined }, { verificationProtocol: undefined }]) {
    expect(() => parseRuntimeConfiguration({ ...config, ...patch })).toThrow('candidate verification');
  }
});
