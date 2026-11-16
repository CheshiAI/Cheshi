import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync as createSymbolicLink, linkSync as createHardLink, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { newGoal } from './decision.ts';
import { WorkerWork } from './work.ts';
import { captureWork, WorkFiles, workDigest } from './work-files.ts';
import { assertWorkRequest, assertWorkResult, collaborationBatch, parseWorkRequest, parseWorkResult } from './work-contract.ts';

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), 'cheshi-work-')); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const spec = { objective: 'Implement greeting', criteria: ['Greeting returns hello'], writePaths: ['src/greet.ts', 'src/new.ts'], paths: ['src/greet.ts', 'context.txt'], previousRequestId: null };
function fixture() {
  const root = directory(), project = join(root, 'project'); mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src/greet.ts'), 'old'); writeFileSync(join(project, 'context.txt'), 'reference');
  const request = captureWork(project, spec);
  return { root, project, request, files: new WorkFiles(join(root, 'work'), 'a'.repeat(64), request) };
}
test('separate snapshots retain edits across reconstruction without changing source or sibling work', () => {
  const f = fixture(), other = new WorkFiles(join(f.root, 'work'), 'b'.repeat(64), f.request);
  writeFileSync(join(f.project, 'src/greet.ts'), 'user changed original');
  expect(f.files.read('src/greet.ts').content).toBe('old');
  f.files.write('src/greet.ts', 'hello'); f.files.write('src/new.ts', 'new');
  const restored = new WorkFiles(join(f.root, 'work'), 'a'.repeat(64), f.request, true);
  const result = restored.result('Proposed greeting');
  expect(result.changes.map(c => c.path)).toEqual(['src/greet.ts', 'src/new.ts']);
  assertWorkResult(f.request, result, workDigest);
  expect(other.read('src/greet.ts').content).toBe('old');
  expect(readFileSync(join(f.project, 'src/greet.ts'), 'utf8')).toBe('user changed original');
  expect(() => new WorkFiles(join(f.root, 'work'), 'c'.repeat(64), f.request, true)).toThrow('missing');
  f.files.write('src/greet.ts', null);
  expect(f.files.result('Proposed deletion').changes[0]?.content).toBeNull();
});
test('path traversal, read-only files, symlinks, hardlinks and unexpected files cannot become a proposal', () => {
  const f = fixture();
  for (const path of ['../escape', '/tmp/escape', 'src/../../escape', '.git/config', 'src\\escape']) expect(() => f.files.write(path, 'bad')).toThrow();
  expect(() => f.files.write('context.txt', 'bad')).toThrow('scope');
  expect(() => f.files.read('../escape')).toThrow('snapshot');
  const target = join(f.files.directory, 'src/greet.ts');
  unlinkSync(target); createSymbolicLink(join(f.project, 'src/greet.ts'), target);
  expect(() => f.files.write('src/greet.ts', 'bad')).toThrow();
  expect(() => f.files.result('bad')).toThrow();
  unlinkSync(target); createHardLink(join(f.project, 'src/greet.ts'), target);
  expect(() => f.files.write('src/greet.ts', 'bad')).toThrow('linked');
  unlinkSync(target); writeFileSync(target, 'old');
  writeFileSync(join(f.files.directory, 'rogue.txt'), 'bad');
  expect(() => f.files.result('bad')).toThrow('Unexpected');
  expect(readFileSync(join(f.project, 'src/greet.ts'), 'utf8')).toBe('old');
});
test('snapshot capture rejects directories, symbolic ancestors, binary data and ambiguous paths', () => {
  const f = fixture();
  createSymbolicLink(join(f.project, 'src'), join(f.project, 'linked'));
  expect(() => captureWork(f.project, { ...spec, paths: ['linked/greet.ts'] })).toThrow('Symlinks');
  expect(() => captureWork(f.project, { ...spec, paths: ['src'] })).toThrow('text files');
  writeFileSync(join(f.project, 'binary'), Buffer.from([0xff, 0]));
  expect(() => captureWork(f.project, { ...spec, paths: ['binary'] })).toThrow();
  expect(() => parseWorkRequest({ ...f.request, files: [...f.request.files, { path: 'SRC/greet.ts', content: null, sha256: null }] })).toThrow('Overlapping');
  expect(() => assertWorkRequest({ ...f.request, snapshot: '0'.repeat(64) }, workDigest)).toThrow('changed');
  expect(() => assertWorkRequest({ ...f.request, files: f.request.files.map(file => ({ ...file, content: 'forged' })) }, workDigest)).toThrow();
});
function collaborators() {
  const f = fixture(), roster = ['owner', 'peer'].map(id => ({ id, name: id, role: 'development', fileWrite: true, workProtocol: 1 as const }));
  const owner = new AgentStore(join(f.root, 'owner')), peer = new AgentStore(join(f.root, 'peer'));
  const a = new WorkerCollaboration(owner, 'owner', f.project), b = new WorkerCollaboration(peer, 'peer', f.project);
  for (const c of [a, b]) c.exchange({ peers: roster, rooms: { room: ['owner', 'peer'] }, messages: [], acknowledged: [] });
  const goal = owner.create('goal', 'Implement greeting', { goal: newGoal(), roomId: 'room' });
  const work = new WorkerWork(owner, f.project, 'owner', true), recipient = new WorkerWork(peer, f.project, 'peer', true);
  const args = { agentId: 'peer', requestId: 'greet', ...spec };
  const result = work.call(goal, 'request_work', args);
  const message = owner.snapshot().collaboration.outgoing[0]!;
  b.exchange({ peers: roster, rooms: { room: ['owner', 'peer'] }, messages: [message], acknowledged: [] });
  const task = peer.create(`w_${message.id}`, 'Implement greeting', { roomId: 'room', delegation: message.id });
  recipient.files(task);
  return { ...f, roster, owner, peer, a, b, goal, work, recipient, args, result, message, task };
}
test('work tools deduplicate capture, validate permissions and collect actual file content instead of a model claim', () => {
  const f = collaborators();
  writeFileSync(join(f.project, 'src/greet.ts'), 'changed after request');
  expect(f.work.call(f.goal, 'request_work', f.args)).toMatchObject({ requestId: f.result.requestId, snapshot: f.result.snapshot });
  expect(() => f.work.call(f.goal, 'request_work', { ...f.args, objective: 'different' })).toThrow('identity');
  expect(() => new WorkerWork(f.owner, f.project, 'owner', false).call(f.goal, 'request_work', f.args)).toThrow('writable');
  expect(() => new WorkerWork(f.peer, f.project, 'peer', false).call(f.task, 'work_write', { path: 'src/greet.ts', content: 'bad' })).toThrow('permission');
  f.recipient.call(f.task, 'work_write', { path: 'src/greet.ts', content: 'hello' });
  f.recipient.call(f.task, 'submit_work', { summary: 'Greeting implemented' });
  const saved = f.peer.task(f.task.id)!;
  expect(() => f.recipient.call(saved, 'work_write', { path: 'src/greet.ts', content: 'late' })).toThrow('End the turn');
  const message = f.recipient.resultMessage(saved, 'completed', 'Claimed success');
  const result = parseWorkResult(JSON.parse(message.text));
  expect(result.changes[0]?.content).toBe('hello');
  expect(result.changes[0]?.sha256).toBe(workDigest('hello'));
  f.a.exchange({ peers: f.roster, rooms: { room: ['owner', 'peer'] }, messages: [message], acknowledged: [f.message.id] });
  expect(f.a.waiting('goal')).toBe(true);
  expect(f.a.waiting('goal', [message.id])).toBe(false);
  expect(f.a.next()?.taskId).not.toBe(f.task.id);
});
test('reviewed revisions start from the submitted copy and cannot widen write scope', () => {
  const f = collaborators();
  f.recipient.call(f.task, 'work_write', { path: 'src/greet.ts', content: 'hello v1' });
  f.recipient.call(f.task, 'submit_work', { summary: 'First draft' });
  const result = f.recipient.resultMessage(f.peer.task(f.task.id)!, 'completed', '');
  f.a.exchange({ peers: f.roster, rooms: { room: ['owner', 'peer'] }, messages: [result], acknowledged: [f.message.id] });
  const review = { requestId: f.message.id, decision: 'changes_requested', feedback: 'Use uppercase' };
  expect(f.work.call(f.goal, 'review_work', review)).toMatchObject({ decision: 'changes_requested', appliedToProject: false });
  expect(f.work.call(f.goal, 'review_work', review)).toMatchObject({ decision: 'changes_requested' });
  expect(() => f.work.call(f.goal, 'review_work', { ...review, decision: 'accepted' })).toThrow('different content');
  expect(() => f.work.call(f.goal, 'request_work', { ...f.args, requestId: 'revision', previousRequestId: f.message.id, writePaths: ['context.txt'] })).toThrow('expand');
  const revision = f.work.call(f.goal, 'request_work', { ...f.args, requestId: 'revision', previousRequestId: f.message.id });
  const request = parseWorkRequest(JSON.parse(f.owner.snapshot().collaboration.outgoing.find(m => m.id === revision.requestId)!.text));
  expect(request.files.find(file => file.path === 'src/greet.ts')?.content).toBe('hello v1');
  expect(readFileSync(join(f.project, 'src/greet.ts'), 'utf8')).toBe('old');
});
test('unsubmitted, failed and cancelled executions never produce successful changes; tampered drafts stay unresolved', () => {
  const f = collaborators();
  for (const status of ['completed', 'failed', 'interrupted']) {
    const result = parseWorkResult(JSON.parse(f.recipient.resultMessage(f.task, status, 'No usable submission').text));
    expect(result.status).not.toBe('submitted'); expect(result.changes).toEqual([]);
  }
  f.recipient.call(f.task, 'work_write', { path: 'src/greet.ts', content: 'proposal' });
  f.recipient.call(f.task, 'submit_work', { summary: 'Ready' });
  writeFileSync(join(f.recipient.files(f.task).directory, 'src/greet.ts'), 'tampered');
  expect(() => f.recipient.resultMessage(f.peer.task(f.task.id)!, 'completed', '')).toThrow('changed');
});
test('collaboration batches remain byte bounded with escaped text and preserve order', () => {
  const messages = Array.from({ length: 20 }, (_, id) => ({ id, text: '\\"한'.repeat(30_000) }));
  const batch = collaborationBatch(messages);
  expect(batch.length).toBeGreaterThan(0); expect(batch.length).toBeLessThan(messages.length);
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(1_510_000);
  expect(batch.map(m => m.id)).toEqual(messages.slice(0, batch.length).map(m => m.id));
});
