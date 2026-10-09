import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertVerificationSource, captureVerificationSource, verificationSourceFiles } from './verification-source-files.ts';
import { workDigest } from './work-files.ts';
import { AgentStore } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { WorkerVerification } from './verification.ts';
import { newGoal } from './decision.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-review-source-')); roots.push(root);
  const project = join(root, 'project'), other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
  writeFileSync(join(project, 'new.ts'), 'export const value = 42;\n');
  writeFileSync(join(other, 'new.ts'), 'stale reviewer checkout');
  writeFileSync(join(other, 'old.ts'), 'not deleted in reviewer checkout');
  return { root, project, other };
}

test('independent reviewer reads delivered additions and deletions, and owner rejects a stale pass', () => {
  const f = fixture(), dev = new AgentStore(join(f.root, 'dev')), review = new AgentStore(join(f.root, 'review'));
  const owner = new WorkerCollaboration(dev, 'dev', f.project), peer = new WorkerCollaboration(review, 'review', f.other);
  const verifier = new WorkerVerification(review, f.other);
  const peers = [{ id: 'dev', name: 'Dev', role: 'development' }, { id: 'review', name: 'Review', role: 'verification' }];
  owner.exchange({ peers, messages: [], acknowledged: [] });
  dev.create('goal', 'Review change', { goal: newGoal(true) });
  owner.call(dev.task('goal')!, 'request_verification', { agentId: 'review', requestId: 'one', criteria: ['Correct change'], paths: ['new.ts', 'old.ts'] });
  const request = dev.snapshot().collaboration.outgoing[0]!;
  peer.exchange({ peers, messages: [request], acknowledged: [] });
  const next = peer.next()!;
  review.create(next.taskId, next.prompt, { verification: next.verification });
  const task = () => review.task(next.taskId)!;
  const cwd = verifier.workspaceFor(task());
  expect(cwd).not.toBe(f.other);
  writeFileSync(join(f.project, 'new.ts'), 'owner changed after requesting review');
  expect(verifier.call(task(), 'verification_read', { path: 'new.ts' }).content).toBe('export const value = 42;\n');
  expect(verifier.call(task(), 'verification_read', { path: 'old.ts' }).content).toBeNull();
  const command = { id: 'check', type: 'commandExecution', command: 'test source', status: 'completed', exitCode: 0, aggregatedOutput: 'pass' };
  verifier.observe(task(), 'item/started', command); verifier.observe(task(), 'item/completed', command);
  verifier.call(task(), 'submit_verification', { verdicts: [{ criterion: 'Correct change', verdict: 'pass', reason: 'Snapshot verified', evidenceIds: task().verificationEvidence!.map(e => e.id) }] });
  peer.publishVerification(task(), verifier.finish(task()));
  const result = review.snapshot().collaboration.outgoing[0]!;
  owner.exchange({ peers, messages: [result], acknowledged: [] });
  expect(() => owner.assertVerified(dev.task('goal')!, [result.id])).toThrow('changed');
  expect(readFileSync(join(f.other, 'new.ts'), 'utf8')).toBe('stale reviewer checkout');
  rmSync(cwd, { recursive: true });
  expect(() => verifier.workspaceFor(task())).toThrow('missing');
});

test('source persistence rejects altered bytes, symlinks, unexpected files and missing saved copies', () => {
  const f = fixture(), source = captureVerificationSource(f.project, ['new.ts', 'old.ts']), id = workDigest('review');
  const files = verificationSourceFiles(f.root, id, source, false);
  expect(verificationSourceFiles(f.root, id, source, true).read('old.ts').content).toBeNull();
  writeFileSync(join(files.directory, 'extra.ts'), 'unrequested');
  expect(() => verificationSourceFiles(f.root, id, source, true)).toThrow('Unexpected');
  rmSync(join(files.directory, 'extra.ts'));
  writeFileSync(join(files.directory, 'new.ts'), 'tampered');
  expect(() => verificationSourceFiles(f.root, id, source, true)).toThrow('changed');
  rmSync(files.directory, { recursive: true });
  expect(() => verificationSourceFiles(f.root, id, source, true)).toThrow('missing');
  createSymbolicLink(f.project, files.directory);
  expect(() => verificationSourceFiles(f.root, id, source, false)).toThrow('Invalid saved');
  expect(() => assertVerificationSource({ ...source, files: source.files.map(file => file.content === null ? file : { ...file, content: 'forged' }) })).toThrow();
});

test('source capture enforces paths, UTF-8 text, size and count limits before transfer', () => {
  const f = fixture();
  createSymbolicLink(join(f.project, 'new.ts'), join(f.project, 'link.ts'));
  writeFileSync(join(f.project, 'large.ts'), 'x'.repeat(65_537));
  writeFileSync(join(f.project, 'binary.ts'), Buffer.from([0xff, 0x00]));
  for (const path of ['../new.ts', '/etc/passwd', 'link.ts', 'large.ts', 'binary.ts']) {
    expect(() => captureVerificationSource(f.project, [path])).toThrow();
  }
  expect(() => captureVerificationSource(f.project, [])).toThrow();
  expect(() => captureVerificationSource(f.project, Array.from({ length: 17 }, (_, i) => `absent-${i}.ts`))).toThrow();
});
