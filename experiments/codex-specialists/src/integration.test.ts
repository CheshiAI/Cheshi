import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerWork } from './work.ts';
import { WorkFiles, workDigest } from './work-files.ts';
import { parseWorkRequest } from './work-contract.ts';
import { WorkerIntegration } from './integration.ts';
import { parseIntegration, type IntegrationSummary } from './integration-contract.ts';
import { newGoal } from './decision.ts';
import { parseRuntimeConfiguration } from './runtime-config.ts';
import type { JsonRecord } from './protocol.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-integration-')); directories.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  for (const name of ['a.txt', 'b.txt', 'context.txt']) writeFileSync(join(project, name), `original ${name}`);
  const store = new AgentStore(join(root, 'owner')), work = new WorkerWork(store, project, 'owner', true);
  const task = store.create('goal', 'Implement and integrate', { goal: newGoal(), roomId: 'room', conversation: 'goal' });
  store.update(task.id, { status: 'interrupted' });
  store.transaction(s => {
    s.collaboration.peers = [{ id: 'owner', name: 'Owner', role: 'development', fileWrite: true, workProtocol: 1 }, { id: 'peer', name: 'Peer', role: 'development', fileWrite: true, workProtocol: 1 }];
    s.collaboration.rooms = { room: ['owner', 'peer'] };
  });
  const integration = new WorkerIntegration(store, project, 'owner', true);
  let sequence = 0;
  function request(paths: string[], writePaths = paths, previousRequestId: string | null = null) {
    const result = work.call(task, 'request_work', { agentId: 'peer', requestId: `request_${++sequence}`, objective: 'Implement scoped files', criteria: ['Files contain proposed changes'], paths, writePaths, previousRequestId });
    return String(result.requestId);
  }
  function submit(id: string, changes: Record<string, string | null>, decision: 'accepted' | 'changes_requested' = 'accepted') {
    const message = store.snapshot().collaboration.outgoing.find(m => m.id === id)!;
    const files = new WorkFiles(join(root, 'peer'), id, parseWorkRequest(JSON.parse(message.text)));
    for (const [path, text] of Object.entries(changes)) files.write(path, text);
    store.transaction(s => s.collaboration.incoming.push({ ...message, id: workDigest(`result/${id}`), from: 'peer', to: 'owner', kind: 'work_result', text: JSON.stringify(files.result('Actual submitted files')) }));
    work.call(task, 'review_work', { requestId: id, decision, feedback: 'Reviewed actual proposal' });
    return id;
  }
  function prepare(ids: string[], requestId = 'candidate') {
    return parseIntegration(integration.call(store.task(task.id)!, 'prepare_integration', { requestId, requestIds: ids }).integration);
  }
  const inspect = () => integration.inspect(store.task(task.id)!)!;
  const candidate = (s: IntegrationSummary) => join(store.directory, 'integrations', s.id, s.candidateHash!);
  return { root, project, store, task, work, integration, request, submit, prepare, inspect, candidate };
}

test('accepted proposals combine in persistent isolated storage, including identical edits and deletion', () => {
  const f = fixture();
  const first = f.submit(f.request(['a.txt', 'context.txt'], ['a.txt']), { 'a.txt': 'A' });
  const second = f.submit(f.request(['a.txt', 'b.txt', 'new.txt']), { 'a.txt': 'A', 'b.txt': null, 'new.txt': 'new' });
  const result = f.prepare([second, first]);
  expect(result.status).toBe('prepared'); expect(result.files).toHaveLength(3);
  expect(readFileSync(join(f.candidate(result), 'a.txt'), 'utf8')).toBe('A');
  expect(existsSync(join(f.candidate(result), 'b.txt'))).toBe(false);
  expect(readFileSync(join(f.candidate(result), 'context.txt'), 'utf8')).toBe('original context.txt');
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('original a.txt');
  expect(readFileSync(join(f.project, 'b.txt'), 'utf8')).toBe('original b.txt');
  expect(existsSync(join(f.project, 'new.txt'))).toBe(false);
  expect(f.prepare([first, second])).toMatchObject({ id: result.id, candidateHash: result.candidateHash, createdAt: result.createdAt });
  const restored = new AgentStore(f.store.directory);
  expect(new WorkerIntegration(restored, f.project, 'owner', true).inspect(restored.task('goal')!)).toMatchObject({ status: 'prepared', candidateHash: result.candidateHash });
  expect(readdirSync(join(f.store.directory, 'integrations'))).toEqual([result.id]);
});

test('revision integration includes cumulative changes even when the final revision changes only one file', () => {
  const f = fixture();
  const first = f.submit(f.request(['a.txt', 'b.txt']), { 'a.txt': 'A1', 'b.txt': 'B1' }, 'changes_requested');
  const second = f.submit(f.request(['a.txt', 'b.txt'], ['a.txt'], first), { 'a.txt': 'A2' });
  const result = f.prepare([second]);
  expect(result.status).toBe('prepared'); expect(result.files).toHaveLength(2);
  expect(result.files.find(x => x.path === 'a.txt')?.before).toBe(workDigest('original a.txt'));
  expect(readFileSync(join(f.candidate(result), 'a.txt'), 'utf8')).toBe('A2');
  expect(readFileSync(join(f.candidate(result), 'b.txt'), 'utf8')).toBe('B1');
  expect(() => f.prepare([first], 'ancestor')).toThrow('accepted');
});

test.each([['first', 'second'], ['first', null], [null, 'second']] as const)('different same-file proposals stop without choosing a winner: %s / %s', (a, b) => {
  const f = fixture(), first = f.submit(f.request(['a.txt']), { 'a.txt': a }), second = f.submit(f.request(['a.txt']), { 'a.txt': b });
  const result = f.prepare([first, second]);
  expect(result).toMatchObject({ status: 'conflict', candidateHash: null, files: [] });
  expect(result.issues).toContainEqual({ kind: 'proposal_conflict', path: 'a.txt', requestIds: [first, second].sort() });
  expect(readdirSync(join(f.store.directory, 'integrations', result.id))).toEqual(['manifest.json']);
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('original a.txt');
});

test('source creation, modification and read-only context changes invalidate preparation and later checks', () => {
  const f = fixture(), id = f.submit(f.request(['a.txt', 'context.txt', 'new.txt'], ['a.txt', 'new.txt']), { 'a.txt': 'A', 'new.txt': 'new' });
  const result = f.prepare([id]);
  writeFileSync(join(f.project, 'new.txt'), 'user new file');
  writeFileSync(join(f.project, 'context.txt'), 'user context');
  expect(f.inspect()).toMatchObject({ status: 'stale', candidateHash: result.candidateHash });
  expect(f.inspect().issues.map(i => i.path).sort()).toEqual(['context.txt', 'new.txt']);
  const failed = f.prepare([id], 'stale-attempt');
  expect(failed).toMatchObject({ status: 'stale', candidateHash: null });
  rmSync(join(f.project, 'new.txt')); writeFileSync(join(f.project, 'context.txt'), 'original context.txt');
  expect(f.prepare([id], 'stale-attempt').status).toBe('stale');
  expect(f.prepare([id], 'fresh-attempt').status).toBe('prepared');
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('original a.txt');
});

test('source symlinks, candidate tampering and missing candidates never become successful retries', () => {
  const f = fixture(), id = f.submit(f.request(['a.txt']), { 'a.txt': 'A' }), prepared = f.prepare([id]);
  writeFileSync(join(f.candidate(prepared), 'a.txt'), 'tampered');
  expect(f.inspect().status).toBe('invalid'); expect(f.prepare([id]).status).toBe('invalid');
  expect(readFileSync(join(f.candidate(prepared), 'a.txt'), 'utf8')).toBe('tampered');
  const fresh = f.prepare([id], 'fresh'); rmSync(f.candidate(fresh), { recursive: true });
  expect(f.inspect().status).toBe('invalid'); expect(f.prepare([id], 'fresh').status).toBe('invalid');
  rmSync(join(f.project, 'a.txt')); createSymbolicLink(join(f.project, 'b.txt'), join(f.project, 'a.txt'));
  expect(f.prepare([id], 'symlink')).toMatchObject({ status: 'stale', issues: [{ kind: 'source_unavailable', path: 'a.txt', requestIds: [id] }] });
});

test('candidate identity survives a lost task-state commit after atomic publication', () => {
  const f = fixture(), id = f.submit(f.request(['a.txt']), { 'a.txt': 'A' });
  const update = f.store.update.bind(f.store); let lose = true;
  f.store.update = (...args) => { if (lose) { lose = false; throw new Error('Lost reference commit'); } update(...args); };
  expect(() => f.prepare([id])).toThrow('Lost reference commit');
  const directories = readdirSync(join(f.store.directory, 'integrations'));
  expect(directories).toHaveLength(1); expect(f.store.task('goal')?.integration).toBeUndefined();
  expect(f.prepare([id])).toMatchObject({ id: directories[0], status: 'prepared' });
  expect(readdirSync(join(f.store.directory, 'integrations'))).toEqual(directories);
});

test('permissions, room-goal scope, review status, hashes and duplicate attempt identities are enforced', () => {
  const f = fixture(), id = f.request(['a.txt']);
  expect(() => f.prepare([id])).toThrow('complete proposal'); f.submit(id, { 'a.txt': 'A' });
  const original = f.prepare([id]);
  const other = f.submit(f.request(['b.txt']), { 'b.txt': 'B' });
  expect(() => f.prepare([other])).toThrow('identity conflict');
  expect(() => f.prepare([id, id], 'duplicate')).toThrow('unique');
  expect(() => new WorkerIntegration(f.store, f.project, 'owner', false).call(f.task, 'prepare_integration', { requestId: 'no', requestIds: [id] })).toThrow('writable');
  expect(() => f.integration.call({ ...f.task, id: 'other-goal' }, 'prepare_integration', { requestId: 'no', requestIds: [id] })).toThrow('room goal');
  f.store.transaction(s => { s.collaboration.incoming.find(m => m.kind === 'work_result' && m.questionId === id)!.text = JSON.stringify({ version: 1, snapshot: '0'.repeat(64), status: 'submitted', summary: 'Forged', changes: [] }); });
  expect(f.integration.inspect(f.store.task('goal')!, original)?.status).toBe('stale');
  expect(() => f.prepare([id], 'forged')).toThrow('snapshot');
});

test('incompatible baselines and cross-proposal path aliases report scope conflicts', () => {
  const f = fixture(), first = f.submit(f.request(['a.txt']), { 'a.txt': 'A' });
  writeFileSync(join(f.project, 'a.txt'), 'new baseline');
  const second = f.submit(f.request(['a.txt']), { 'a.txt': 'A' });
  expect(f.prepare([first, second]).issues.some(i => i.kind === 'scope_conflict')).toBe(true);
  const lower = f.submit(f.request(['new/file.txt']), { 'new/file.txt': 'one' });
  const upper = f.submit(f.request(['NEW/FILE.txt']), { 'NEW/FILE.txt': 'two' });
  expect(f.prepare([lower, upper], 'case').status).toBe('conflict');
  const parent = f.submit(f.request(['new']), { new: 'parent file' });
  expect(f.prepare([lower, parent], 'parent').status).toBe('conflict');
});

test('malformed integration metadata is rejected at the shared boundary', () => {
  const f = fixture(), id = f.submit(f.request(['a.txt']), { 'a.txt': 'A' }), summary = f.prepare([id]);
  for (const patch of [{ status: 'applied' }, { candidateHash: null }, { requestIds: [] }, { files: [{ path: '../escape', before: null, sha256: 'a'.repeat(64) }] },
    { issues: [{ kind: 'source_changed', path: 'a.txt', requestIds: ['f'.repeat(64)] }] }] satisfies JsonRecord[]) {
    expect(() => parseIntegration({ ...summary, ...patch })).toThrow();
  }
});

test('extra files and missing or modified manifests invalidate saved candidates', () => {
  const f = fixture(), id = f.submit(f.request(['a.txt']), { 'a.txt': 'A' });
  const first = f.prepare([id]);
  writeFileSync(join(f.candidate(first), 'unexpected.txt'), 'extra');
  expect(f.inspect().status).toBe('invalid');
  const second = f.prepare([id], 'second'), manifest = join(f.store.directory, 'integrations', second.id, 'manifest.json');
  const data = JSON.parse(readFileSync(manifest, 'utf8'));
  data.candidate[0].content = 'forged'; writeFileSync(manifest, JSON.stringify(data));
  expect(f.inspect().status).toBe('invalid');
  rmSync(manifest);
  expect(f.inspect().status).toBe('invalid');
  expect(() => f.prepare([id], 'second')).toThrow();
  expect(readFileSync(join(f.project, 'a.txt'), 'utf8')).toBe('original a.txt');
});

test('integration protocol requires supported work protocol and literal capability values', () => {
  const configuration = { profileId: 'owner', accountId: 'account', role: 'development', token: 'a'.repeat(64), instructions: 'Implement',
    model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: true, commandExecution: false }, workProtocol: 1, integrationProtocol: 1 };
  expect(parseRuntimeConfiguration(configuration).integrationProtocol).toBe(1);
  for (const patch of [{ integrationProtocol: true }, { integrationProtocol: 2 }, { workProtocol: undefined }]) {
    expect(() => parseRuntimeConfiguration({ ...configuration, ...patch })).toThrow('integration protocol');
  }
  const f = fixture(), filename = join(f.store.directory, 'state', 'agent.json');
  const saved = JSON.parse(readFileSync(filename, 'utf8'));
  saved.tasks[0].integrationTools = 'true'; writeFileSync(filename, JSON.stringify(saved));
  expect(() => new AgentStore(f.store.directory)).toThrow('capability');
});
