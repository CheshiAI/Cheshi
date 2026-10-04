import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentOrchestration, exchangeWorker } from '../lib/agent-orchestration/service.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { candidateFixture } from '../../experiments/codex-specialists/src/candidate-verification-fixture.ts';
import { WorkerIntegration } from '../../experiments/codex-specialists/src/integration.ts';
import { APPLICATION_LOCK } from '../../experiments/codex-specialists/src/integration-application.ts';

const workerPath = fileURLToPath(new URL('../../experiments/codex-specialists/src/worker.ts', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/specialist-app-server.ts', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(30);
  }
  throw new Error(`Timed out: ${label}`);
}

test('authenticated application endpoint inspects a persisted crash after cold restart without running a goal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-application-process-'));
  const f = candidateFixture(directory), token = 'b'.repeat(64), children: ReturnType<typeof Bun.spawn>[] = [];
  const bin = join(directory, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixturePath)} "$@"\n`); chmodSync(join(bin, 'codex'), 0o700);
  const check = f.requestVerification(); f.observe(check.taskId); f.draft(check.taskId); f.deliver(check.taskId);
  new WorkerIntegration(f.store, f.project, 'owner', true, true).call(f.store.task('goal')!, 'apply_integration', { candidateId: f.candidate.id, hash: f.candidate.hash });
  f.store.update('goal', { status: 'interrupted', goal: { ...f.store.task('goal')!.goal!, phase: 'blocked' } });
  const journal = join(f.store.directory, 'integrations', f.candidate.id, 'application.json');
  const receipt = JSON.parse(readFileSync(journal, 'utf8')); delete receipt.lockReleased; receipt.status = 'applying';
  receipt.files.at(-1).phase = 'writing'; writeFileSync(journal, JSON.stringify(receipt));
  mkdirSync(join(f.project, APPLICATION_LOCK)); writeFileSync(join(f.project, APPLICATION_LOCK, 'owner.json'), JSON.stringify({ id: receipt.id }));
  const config = join(f.store.directory, 'runtime.json');
  writeFileSync(config, JSON.stringify({ profileId: 'owner', accountId: 'fixture', role: 'development', token, revision: 'test',
    instructions: 'Inspect application only', model: null, reasoningEffort: null, serviceTier: null,
    permissions: { fileWrite: true, commandExecution: false }, applicationInspectionProtocol: 1, applicationProtocol: 1,
    candidateVerificationProtocol: 1, integrationProtocol: 1, workProtocol: 1, verificationProtocol: 1, decisionProtocol: 1 }));
  const before = f.paths.map(path => existsSync(join(f.project, path)) ? readFileSync(join(f.project, path), 'utf8') : null);
  const goal = f.store.task('goal')!.goal;
  try {
    for (let round = 0; round < 2; round++) {
      const port = await freePort(), endpoint = `http://127.0.0.1:${port}`;
      const child = Bun.spawn([process.execPath, workerPath], { cwd: dirname(workerPath), stdout: 'pipe', stderr: 'pipe',
        env: { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(f.store.directory, 'codex'), FIXTURE_PROFILE: 'owner',
          AGENT_DATA_DIRECTORY: f.store.directory, AGENT_RUNTIME_CONFIG: config, AGENT_RUNTIME_REVISION: 'test', AGENT_WORKSPACE: f.project, AGENT_PORT: String(port) } });
      children.push(child);
      await until(async () => { try { return (await fetch(`${endpoint}/health`)).ok; } catch { return false; } }, 'application worker startup');
      const body = JSON.stringify({ roomId: 'room', candidateId: f.candidate.id, hash: f.candidate.hash });
      expect((await fetch(`${endpoint}/tasks/goal/application`, { method: 'POST', body })).status).toBe(401);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      expect((await fetch(`${endpoint}/tasks/goal/application`, { method: 'POST', headers: { ...headers, Origin: 'http://example.test' }, body })).status).toBe(403);
      expect((await fetch(`${endpoint}/tasks/goal/application`, { method: 'POST', headers, body: JSON.stringify({ roomId: 'foreign', candidateId: f.candidate.id, hash: f.candidate.hash }) })).ok).toBe(false);
      const response = await fetch(`${endpoint}/tasks/goal/application`, { method: 'POST', headers, body });
      expect(response.status).toBe(200);
      const task = await response.json();
      expect(task.integration.application).toMatchObject({ status: 'applied', lockReleased: true });
      expect(task.status).toBe('interrupted'); expect(task.goal).toEqual(goal); expect(task.threadId).toBeNull();
      expect(task.integration.projectVerification?.status).not.toBe('pass');
      expect(f.paths.map(path => existsSync(join(f.project, path)) ? readFileSync(join(f.project, path), 'utf8') : null)).toEqual(before);
      expect(existsSync(join(f.project, APPLICATION_LOCK))).toBe(false);
      child.kill('SIGTERM'); await child.exited;
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exited)); rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

for (const roomScoped of [false, true]) test(`real worker processes exchange tools and resume after cold restart (${roomScoped ? 'room' : 'project'}) without provider calls`, async () => {
  const taskId = roomScoped ? 'chats_login' : 'login';
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-worker-process-'));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const token = 'b'.repeat(64), endpoints = new Map<string, string>();
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const fixture = join(directory, 'fixture.ts'); copyFileSync(fixturePath, fixture);
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`);
  chmodSync(join(bin, 'codex'), 0o700);
  const start = async (id: string) => {
    const data = join(directory, id); mkdirSync(data, { recursive: true });
    const config = join(data, 'runtime.json');
    writeFileSync(config, JSON.stringify({ decisionProtocol: 1, profileId: id, accountId: 'fixture', role: 'development', token, revision: 'test',
      instructions: 'Fixture instructions', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite: false, commandExecution: false } }));
    const port = await freePort();
    const child = Bun.spawn([process.execPath, workerPath], {
      cwd: dirname(workerPath), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(data, 'codex'), FIXTURE_PROFILE: id,
        AGENT_DATA_DIRECTORY: data, AGENT_RUNTIME_CONFIG: config, AGENT_RUNTIME_REVISION: 'test', AGENT_WORKSPACE: directory, AGENT_PORT: String(port) },
    });
    children.push(child);
    const endpoint = `http://127.0.0.1:${port}`; endpoints.set(id, endpoint);
    await until(async () => {
      try { return (await fetch(`${endpoint}/health`)).ok; } catch { return false; }
    }, `${id} worker startup`);
    return child;
  };
  const peers = [{ id: 'dev', name: 'Developer', role: 'development' }, { id: 'planner', name: 'Planner', role: 'planning' }];
  const relay = () => createAgentOrchestration({ filename: join(directory, 'mailbox.json'),
    ...(roomScoped ? { rooms: { roster: () => ({ room: ['dev', 'planner'] }), allowed: (_binding: unknown, m: { roomId?: string }) => m.roomId === 'room', record: () => {} } } : {}),
    peer: binding => peers.find(p => p.id === binding.agentId) ?? null,
    connect: async binding => ({ endpoint: endpoints.get(binding.agentId)!, token }),
  });
  let coordinator = relay();
  const task = async () => (await (await fetch(`${endpoints.get('dev')}/tasks/${taskId}`)).json()) as { status: string; threadId: string; output: string; goal?: { phase: string; turns: number; decisions: { action: string }[] } };
  try {
    let developer = await start('dev'); await start('planner');
    peers.forEach(p => coordinator.register(bindingFor(directory, 'docker:fixture', p.id, 'fixture')));
    await coordinator.tick();
    const unauthorized = await fetch(`${endpoints.get('dev')}/collaboration/exchange`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    const accepted = await fetch(`${endpoints.get('dev')}/tasks`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, prompt: 'Complete login.', ...(roomScoped ? { chat: { roomId: 'room', conversation: taskId, goal: true } } : {}) }) });
    expect(accepted.status).toBe(202);
    await until(async () => (await task()).status === 'waiting', 'question wait');
    const before = await task(); expect(before.goal?.phase).toBe('waiting'); expect(before.output).toContain('Independent input validation');
    await coordinator.tick();
    developer.kill('SIGTERM'); await developer.exited;
    await coordinator.dispose(); coordinator = relay();
    developer = await start('dev');
    expect((await task()).status).toBe('waiting');
    await until(async () => { await coordinator.tick(); return (await task()).status === 'completed'; }, 'answer and resumed task');
    const after = await task();
    if (roomScoped) { expect(after).toHaveProperty('roomId', 'room'); expect(after).toHaveProperty('responses'); }
    expect(after.threadId).toBe(before.threadId);
    expect(after.goal).toMatchObject({ phase: 'completed', turns: 3 });
    expect(after.goal?.decisions.map(d => d.action)).toEqual(['wait', 'continue', 'complete']);
    expect(after.output).toBe('Continued login using the received policy.');
    expect(coordinator.error(bindingFor(directory, 'docker:fixture', 'dev', 'fixture').id)).toBeNull();
    const direct = await exchangeWorker({ endpoint: endpoints.get('dev')!, token }, { peers, messages: [], acknowledged: [] });
    expect(direct).toHaveProperty('protocol', 1);
  } finally {
    await coordinator.dispose();
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
