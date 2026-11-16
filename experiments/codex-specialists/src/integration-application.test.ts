import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync as createHardLink, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateFixture } from './candidate-verification-fixture.ts';
import { WorkerIntegration } from './integration.ts';
import { IntegrationApplication, APPLICATION_LOCK } from './integration-application.ts';
import { parseApplication } from './application-contract.ts';
import { AgentStore } from './store.ts';
import { workDigest } from './work-files.ts';
import { parseIntegration } from './integration-contract.ts';
import * as fs from 'node:fs';
import { assertApplicationRecords, readApplicationRecords } from './application-storage.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-apply-')); roots.push(root);
  const f = candidateFixture(root);
  const integration = new WorkerIntegration(f.store, f.project, 'owner', true, true);
  const args = { candidateId: f.candidate.id, hash: f.candidate.hash };
  const directory = join(f.store.directory, 'integrations', f.candidate.id);
  const journal = join(directory, 'application.json');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const application = () => new IntegrationApplication(directory, f.project, 'owner', f.candidate.id, f.candidate.hash, manifest.baseline, manifest.candidate);
  const apply = () => integration.call(f.store.task('goal')!, 'apply_integration', args);
  const recover = () => integration.call(f.store.task('goal')!, 'recover_integration', args);
  const inspect = () => integration.inspect(f.store.task('goal')!)!;
  const pass = () => { const task = f.requestVerification(); f.observe(task.taskId); f.draft(task.taskId); f.deliver(task.taskId); return task; };
  function crash(phases: ('pending' | 'writing' | 'written')[], contents: ('before' | 'after' | 'changed')[]) {
    const receipt = { id: workDigest(`application/owner/${f.candidate.id}/${f.candidate.hash}`), candidateId: f.candidate.id, hash: f.candidate.hash,
      verificationId: f.store.snapshot().collaboration.outgoing.find(m => m.kind === 'verification_request')!.id,
      status: 'applying', updatedAt: new Date().toISOString(), files: f.candidate.files.map((file, i) => ({ path: file.path,
        before: workDigest(`original ${file.path}`), after: file.sha256, phase: phases[i] })) };
    mkdirSync(join(f.project, APPLICATION_LOCK));
    writeFileSync(join(f.project, APPLICATION_LOCK, 'owner.json'), JSON.stringify({ id: receipt.id }));
    writeFileSync(journal, JSON.stringify(receipt));
    f.candidate.files.forEach((file, i) => {
      if (contents[i] === 'changed') writeFileSync(join(f.project, file.path), 'user edit');
      if (contents[i] === 'after') {
        if (file.content === null) rmSync(join(f.project, file.path)); else writeFileSync(join(f.project, file.path), file.content);
      }
    });
  }
  return { ...f, integration, args, directory, journal, application, apply, recover, inspect, pass, crash };
}

test('apply requires current candidate verification, exact identity and existing file-write permission', () => {
  const f = fixture();
  expect(() => f.apply()).toThrow('passed independent');
  f.pass();
  expect(() => f.integration.call(f.store.task('goal')!, 'apply_integration', { ...f.args, hash: '0'.repeat(64) })).toThrow('exact');
  expect(() => new WorkerIntegration(f.store, f.project, 'owner', false, true).call(f.store.task('goal')!, 'apply_integration', f.args)).toThrow('writable');
  expect(() => new WorkerIntegration(f.store, f.project, 'owner', true).call(f.store.task('goal')!, 'apply_integration', f.args)).toThrow('updated');
  writeFileSync(join(f.project, f.paths[0]!), 'user edit');
  expect(() => f.apply()).toThrow('current candidate');
  expect(readFileSync(join(f.project, f.paths[0]!), 'utf8')).toBe('user edit');
  expect(existsSync(f.journal)).toBe(false);
});

test('application preserves modes, deletes scoped files, survives lost acknowledgement and requires fresh project verification', () => {
  const f = fixture(); f.pass(); chmodSync(join(f.project, f.paths[0]!), 0o755);
  f.apply();
  const receipt = f.inspect().application!;
  expect(receipt.status).toBe('applied');
  expect(existsSync(join(f.project, f.paths[1]!))).toBe(false);
  expect(statSync(join(f.project, f.paths[0]!)).mode & 0o777).toBe(0o755);
  expect(existsSync(join(f.project, APPLICATION_LOCK))).toBe(false);
  const originalJournal = readFileSync(f.journal, 'utf8');
  f.apply(); expect(readFileSync(f.journal, 'utf8')).toBe(originalJournal);
  const store = new AgentStore(f.store.directory), restored = new WorkerIntegration(store, f.project, 'owner', true, true);
  expect(restored.inspect(store.task('goal')!)?.application?.id).toBe(receipt.id);
  expect(() => restored.assertComplete(store.task('goal')!)).toThrow('independently verified');
  const args = { ...f.args, candidateId: f.candidate.id };
  expect(restored.call(store.task('goal')!, 'recover_integration', args).appliedToProject).toBe(true);
});

test('project verification runs on actual project with separate identity; source edits invalidate the pass', () => {
  const f = fixture(); f.pass(); f.apply();
  const task = f.store.task('goal')!, snapshot = f.integration.snapshot(task);
  expect(snapshot.applicationId).toBe(f.inspect().application?.id);
  f.owner.call(task, 'request_verification', { ...f.args, agentId: 'verifier', requestId: 'project-check', criteria: ['Candidate is correct'], paths: f.paths }, snapshot);
  const message = f.store.snapshot().collaboration.outgoing.at(-1)!;
  f.peer.exchange({ peers: f.roster, rooms: f.rooms, messages: [message], acknowledged: [] });
  const next = f.peer.next()!;
  f.reviewer.create(next.taskId, next.prompt, { verification: next.verification, roomId: 'room', conversation: next.taskId });
  expect(f.verifier.workspaceFor(f.reviewer.task(next.taskId)!, false)).toBe(f.project);
  f.observe(next.taskId); f.draft(next.taskId);
  const reply = f.deliver(next.taskId);
  expect(f.inspect().projectVerification?.status).toBe('pass');
  expect(parseIntegration(f.inspect()).projectVerification?.result?.candidate?.applicationId).toBe(snapshot.applicationId);
  expect(() => f.integration.assertComplete(f.store.task('goal')!)).toThrow('Process');
  f.integration.assertComplete(f.store.task('goal')!, [reply.id]);
  writeFileSync(join(f.project, f.paths[0]!), 'new user change');
  expect(f.inspect().projectVerification?.status).toBe('stale');
  expect(() => f.integration.assertComplete(f.store.task('goal')!, [reply.id])).toThrow();
  expect(f.verifier.recover(f.reviewer.task(next.taskId)!, { threadId: 't', turnId: 'turn', status: 'completed', checkedAt: new Date().toISOString() }).verdicts[0]?.verdict).toBe('inconclusive');
});

test.each(['partial', 'external', 'written-without-receipt', 'before-write'] as const)('restart recovery inspects %s without replaying or restoring files', kind => {
  const f = fixture(); f.pass();
  if (kind === 'partial') f.crash(['written', 'pending', 'pending'], ['after', 'before', 'before']);
  if (kind === 'external') f.crash(['written', 'pending', 'pending'], ['after', 'changed', 'before']);
  if (kind === 'written-without-receipt') f.crash(['written', 'written', 'writing'], ['after', 'after', 'after']);
  if (kind === 'before-write') f.crash(['writing', 'pending', 'pending'], ['before', 'before', 'before']);
  const contents = () => f.paths.map(path => existsSync(join(f.project, path)) ? readFileSync(join(f.project, path), 'utf8') : null);
  const before = contents();
  expect(() => assertApplicationRecords(readApplicationRecords(fs, f.store.directory))).toThrow('Unresolved');
  f.apply(); expect(contents()).toEqual(before);
  f.recover(); expect(contents()).toEqual(before);
  const inspected = f.inspect();
  expect(inspected.application?.status).toBe(kind === 'written-without-receipt' ? 'applied' : kind === 'before-write' ? 'aborted' : kind === 'external' ? 'conflict' : 'interrupted');
  expect(inspected.issues).toEqual(kind === 'external' ? [{ kind: 'source_changed', path: null, requestIds: inspected.requestIds }] : []);
  expect(inspected.status).toBe(kind === 'written-without-receipt' ? 'prepared' : 'stale');
  expect(inspected.verification?.status).toBe(kind === 'written-without-receipt' ? 'pass' : 'stale');
  expect(inspected.projectVerification).toBeUndefined();
  expect(parseIntegration(JSON.parse(JSON.stringify(inspected)))).toEqual(inspected);
  if (kind === 'before-write' || kind === 'partial') {
    for (const status of ['prepared', 'conflict', 'invalid']) expect(() => parseIntegration({ ...inspected, status })).toThrow();
    expect(() => parseIntegration({ ...inspected, application: undefined })).toThrow();
    for (const status of ['applying', 'applied', 'conflict']) {
      expect(() => parseIntegration({ ...inspected, application: { ...inspected.application, status } })).toThrow();
    }
    expect(() => parseIntegration({ ...inspected, verification: { ...inspected.verification, status: 'pass' } })).toThrow();
    expect(() => parseIntegration({ ...inspected, projectVerification: { ...inspected.verification, status: 'pass' } })).toThrow();
  }
  expect(() => f.integration.assertComplete(f.store.task('goal')!)).toThrow('independently verified');
  expect(existsSync(join(f.project, APPLICATION_LOCK))).toBe(kind === 'partial' || kind === 'external');
  if (kind === 'partial' || kind === 'external') expect(() => assertApplicationRecords(readApplicationRecords(fs, f.store.directory))).toThrow('Unresolved');
  else expect(() => assertApplicationRecords(readApplicationRecords(fs, f.store.directory))).not.toThrow();
});

test('intent saved before acquiring a lock blocks deletion and can be inspected as an aborted attempt', () => {
  const f = fixture(); f.pass(); f.crash(['pending', 'pending', 'pending'], ['before', 'before', 'before']);
  rmSync(join(f.project, APPLICATION_LOCK), { recursive: true });
  expect(() => assertApplicationRecords(readApplicationRecords(fs, f.store.directory))).toThrow('Unresolved');
  f.recover();
  expect(f.inspect().application).toMatchObject({ status: 'aborted', lockReleased: true });
  expect(() => assertApplicationRecords(readApplicationRecords(fs, f.store.directory))).not.toThrow();
  expect(readFileSync(join(f.project, f.paths[0]!), 'utf8')).toBe(`original ${f.paths[0]}`);
});

test('legacy terminal receipts require explicit inspection and external edits never retain a release claim', () => {
  const f = fixture(); f.pass(); f.apply();
  const saved = JSON.parse(readFileSync(f.journal, 'utf8')); delete saved.lockReleased;
  writeFileSync(f.journal, JSON.stringify(saved));
  expect(() => assertApplicationRecords(readApplicationRecords(fs, f.store.directory))).toThrow('Unresolved');
  f.recover();
  expect(() => assertApplicationRecords(readApplicationRecords(fs, f.store.directory))).not.toThrow();
  writeFileSync(join(f.project, f.paths[0]!), `original ${f.paths[0]}`);
  expect(f.inspect().application).toMatchObject({ status: 'interrupted' });
  expect(f.inspect().application?.lockReleased).toBeUndefined();
  f.recover();
  expect(f.inspect().application?.lockReleased).toBeUndefined();
});

test('lock ownership, unsafe project links and altered journals stop application without clearing someone else’s lock', () => {
  const f = fixture(); f.pass();
  mkdirSync(join(f.project, APPLICATION_LOCK)); writeFileSync(join(f.project, APPLICATION_LOCK, 'owner.json'), JSON.stringify({ id: 'other' }));
  expect(() => f.apply()).toThrow(); expect(existsSync(f.journal)).toBe(false);
  expect(readFileSync(join(f.project, APPLICATION_LOCK, 'owner.json'), 'utf8')).toContain('other');
  rmSync(join(f.project, APPLICATION_LOCK), { recursive: true });
  rmSync(join(f.project, f.paths[0]!)); createSymbolicLink(join(f.project, f.paths[2]!), join(f.project, f.paths[0]!));
  expect(() => f.apply()).toThrow();
  rmSync(join(f.project, f.paths[0]!)); writeFileSync(join(f.project, f.paths[0]!), `original ${f.paths[0]}`);
  createHardLink(join(f.project, f.paths[0]!), join(f.project, 'hardlink'));
  expect(() => f.apply()).toThrow('Linked');
  const journal = JSON.parse(readFileSync(f.journal, 'utf8')); journal.hash = '0'.repeat(64); writeFileSync(f.journal, JSON.stringify(journal));
  expect(f.inspect().status).toBe('invalid');
  expect(() => f.recover()).toThrow('changed');
});

test('malformed application and mismatched project verification receipts cannot be presented as success', () => {
  const f = fixture(); f.pass(); f.apply();
  const receipt = f.inspect().application!;
  expect(() => parseApplication({ ...receipt, status: true })).toThrow();
  expect(() => parseApplication({ ...receipt, files: receipt.files.map(file => ({ ...file, phase: 'pending' })) })).toThrow();
  expect(() => parseIntegration({ ...f.inspect(), application: { ...receipt, hash: '0'.repeat(64) } })).toThrow();
  expect(() => parseIntegration({ ...f.inspect(), projectVerification: f.inspect().verification })).toThrow();
  rmSync(f.journal);
  expect(f.inspect().status).toBe('invalid');
  expect(() => f.apply()).toThrow('changed');
});

test('new nested files are created exclusively and unselected project files remain intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-apply-add-')); roots.push(root);
  const project = join(root, 'project'), directory = join(root, 'journal'); mkdirSync(project); mkdirSync(directory);
  writeFileSync(join(project, 'keep.txt'), 'keep');
  const baseline = [{ path: 'new/nested.ts', content: null, sha256: null }];
  const candidate = [{ path: 'new/nested.ts', content: 'export const value = 1;', sha256: workDigest('export const value = 1;') }];
  const application = new IntegrationApplication(directory, project, 'owner', 'a'.repeat(64), 'b'.repeat(64), baseline, candidate);
  expect(application.apply('c'.repeat(64)).status).toBe('applied');
  expect(readFileSync(join(project, 'new/nested.ts'), 'utf8')).toBe(candidate[0]!.content);
  expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('keep');
  writeFileSync(join(project, 'new/nested.ts'), 'user changed');
  expect(application.apply('c'.repeat(64)).status).toBe('conflict');
  expect(readFileSync(join(project, 'new/nested.ts'), 'utf8')).toBe('user changed');
});

test('a crash after the final write retains an inspection gate until the owned lock and staged files are released', () => {
  const f = fixture(); f.pass(); f.crash(['written', 'written', 'written'], ['after', 'after', 'after']);
  const saved = JSON.parse(readFileSync(f.journal, 'utf8')); saved.status = 'applied'; writeFileSync(f.journal, JSON.stringify(saved));
  const staged = join(f.project, APPLICATION_LOCK, `stage-${workDigest(f.paths[0]!)}`);
  createHardLink(join(f.project, f.paths[0]!), staged);
  expect(f.inspect().application?.status).toBe('interrupted');
  f.recover();
  expect(existsSync(join(f.project, APPLICATION_LOCK))).toBe(false);
  expect(statSync(join(f.project, f.paths[0]!)).nlink).toBe(1);
  expect(f.inspect().application?.status).toBe('applied');
});
