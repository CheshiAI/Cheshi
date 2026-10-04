import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { AgentStore } from '../../experiments/codex-specialists/src/store.ts';
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return address.port;
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(30); }
  throw new Error('Worker did not reach the expected state');
}
test('real worker HTTP gate authenticates sleep, refuses new work while draining and preserves waiting state across cold start', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-idle-process-'));
  const children: ReturnType<typeof Bun.spawn>[] = [], token = 'a'.repeat(64);
  try {
    const bin = join(directory, 'bin'), data = join(directory, 'data'); mkdirSync(bin);
    const fixture = new URL('./fixtures/specialist-app-server.ts', import.meta.url).pathname;
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`);
    chmodSync(join(bin, 'codex'), 0o700);
    const store = new AgentStore(data); store.create('waiting', 'Keep this conversation'); store.update('waiting', { status: 'waiting' });
    const config = join(data, 'runtime.json');
    writeFileSync(config, JSON.stringify({ profileId: 'planner', accountId: 'fixture', role: 'planning', token, revision: 'test', instructions: 'Fixture',
      model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false } }));
    const launch = async () => {
      const port = await freePort(), endpoint = `http://127.0.0.1:${port}`;
      const child = Bun.spawn([process.execPath, new URL('../../experiments/codex-specialists/src/worker.ts', import.meta.url).pathname], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_DATA_DIRECTORY: data, AGENT_WORKSPACE: directory,
          AGENT_RUNTIME_CONFIG: config, AGENT_RUNTIME_REVISION: 'test', AGENT_PORT: String(port), FIXTURE_PROFILE: 'planner' }, stdout: 'ignore', stderr: 'pipe' });
      children.push(child);
      await until(async () => { try { return (await fetch(`${endpoint}/health`)).ok; } catch { return false; } });
      const post = (path: string, body: unknown = {}, auth = token) => fetch(`${endpoint}${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { child, endpoint, post };
    };
    const first = await launch();
    expect((await first.post('/lifecycle/prepare', {}, 'wrong')).status).toBe(401);
    const prepared = await first.post('/lifecycle/prepare'); expect(prepared.ok).toBe(true);
    const receipt = await prepared.json() as { lease: string; idle: boolean }; expect(receipt.idle).toBe(true);
    expect((await first.post('/tasks', { id: 'late', prompt: 'Must remain unsent' })).status).toBe(409);
    expect((await first.post('/lifecycle/commit', { lease: receipt.lease })).ok).toBe(true);
    expect(await first.child.exited).toBe(0);
    const next = await launch();
    const waiting = await (await fetch(`${next.endpoint}/tasks/waiting`)).json() as { status: string };
    expect(waiting.status).toBe('waiting');
    expect((await fetch(`${next.endpoint}/tasks/late`)).status).toBe(404);
    expect((await next.post('/tasks', { id: 'new', prompt: 'Answer now' })).status).toBe(202);
    await until(async () => (await (await fetch(`${next.endpoint}/tasks/new`)).json() as { status: string }).status === 'completed');
    const again = await next.post('/lifecycle/prepare'); expect(again.ok).toBe(true);
    expect((await next.post('/lifecycle/resume')).ok).toBe(true);
    expect((await next.post('/tasks', { id: 'after-cancel', prompt: 'Continue after canceled sleep' })).status).toBe(202);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(children.map(child => child.exited)); rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
