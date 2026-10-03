import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentOrchestration, exchangeWorker } from '../lib/agent-orchestration/service.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';

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

test('real worker processes exchange tools over stdio and HTTP and resume after a cold restart without provider calls', async () => {
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
    peer: binding => peers.find(p => p.id === binding.agentId) ?? null,
    connect: async binding => ({ endpoint: endpoints.get(binding.agentId)!, token }),
  });
  let coordinator = relay();
  const task = async () => (await (await fetch(`${endpoints.get('dev')}/tasks/login`)).json()) as { status: string; threadId: string; output: string; goal?: { phase: string; turns: number; decisions: { action: string }[] } };
  try {
    let developer = await start('dev'); await start('planner');
    peers.forEach(p => coordinator.register(bindingFor(directory, 'docker:fixture', p.id, 'fixture')));
    await coordinator.tick();
    const unauthorized = await fetch(`${endpoints.get('dev')}/collaboration/exchange`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    const accepted = await fetch(`${endpoints.get('dev')}/tasks`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'login', prompt: 'Complete login.' }) });
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
