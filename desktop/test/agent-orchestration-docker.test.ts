import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { SPECIALIST_WORKER_FILES } from '../../scripts/prepare-specialist-worker.mts';

const execute = promisify(execFile);
const context = process.env.CHESHI_ORCHESTRATION_DOCKER_CONTEXT;
test.if(Boolean(context))('Docker recreation preserves the waiting task, question and native thread binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-docker-orchestration-'));
  const prefix = `cheshi-orchestration-test-${randomUUID()}`;
  const image = `${prefix}:test`;
  let imageBuilt = false;
  const token = 'c'.repeat(64), endpoints = new Map<string, string>();
  const containers = new Set<string>(), volumes = new Set<string>();
  const docker = async (...args: string[]) => (await execute('docker', ['--context', context!, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  copyFileSync(fileURLToPath(new URL('./fixtures/specialist-app-server.ts', import.meta.url)), join(root, 'fixture.ts'));
  writeFileSync(join(root, 'codex'), '#!/bin/sh\nexec /usr/local/bin/bun /test/fixture.ts "$@"\n', { mode: 0o755 });
  const peers = [{ id: 'dev', name: 'Developer', role: 'development' }, { id: 'planner', name: 'Planner', role: 'planning' }];
  mkdirSync(join(root, 'src'));
  for (const filename of SPECIALIST_WORKER_FILES.filter(file => file.startsWith('src/'))) {
    copyFileSync(fileURLToPath(new URL(`../../experiments/codex-specialists/${filename}`, import.meta.url)), join(root, filename));
  }
  for (const { id } of peers) writeFileSync(join(root, `${id}.json`), JSON.stringify({ decisionProtocol: 1, profileId: id, accountId: 'fixture', role: 'development', token, revision: 'test',
    instructions: 'Read-only fixture.', model: null, reasoningEffort: null, serviceTier: null,
    permissions: { fileWrite: false, commandExecution: false } }));
  writeFileSync(join(root, 'Dockerfile'), 'FROM cheshi-specialist:1\nUSER root\nCOPY src /app/src\nCOPY fixture.ts codex dev.json planner.json /test/\nRUN chmod 755 /test/codex\nUSER node\n');
  const wait = async (check: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(100); }
    throw new Error(`Timed out: ${label}`);
  };
  const start = async (id: string) => {
    const name = `${prefix}-${id}`, volume = `${name}-data`;
    if (!volumes.has(volume)) { await docker('volume', 'create', '--label', `ai.cheshi.test=${prefix}`, volume); volumes.add(volume); }
    await docker('create', '--name', name, '--label', `ai.cheshi.test=${prefix}`, '--init', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--publish', '127.0.0.1::8787',
      '--mount', `type=volume,src=${volume},dst=/agent`,
      '--env', 'PATH=/test:/usr/local/bin:/usr/bin:/bin', '--env', `FIXTURE_PROFILE=${id}`,
      '--env', 'CODEX_HOME=/agent/codex', '--env', `AGENT_RUNTIME_CONFIG=/test/${id}.json`, '--env', 'AGENT_RUNTIME_REVISION=test',
      '--env', 'AGENT_DATA_DIRECTORY=/agent', '--env', 'AGENT_WORKSPACE=/app', image);
    containers.add(name); await docker('start', name);
    const port = await docker('port', name, '8787/tcp'); endpoints.set(id, `http://${port}`);
    await wait(async () => { try { return (await fetch(`${endpoints.get(id)}/health`)).ok; } catch { return false; } }, `${id} health`);
  };
  const relay = () => createAgentOrchestration({ filename: join(root, 'central.json'),
    peer: b => peers.find(p => p.id === b.agentId) ?? null,
    connect: async b => ({ endpoint: endpoints.get(b.agentId)!, token }),
  });
  let coordinator = relay();
  const task = async () => await (await fetch(`${endpoints.get('dev')}/tasks/login`)).json() as { status: string; threadId: string; output: string; goal?: { phase: string; turns: number; decisions: { action: string }[] } };
  try {
    await docker('build', '--network=none', '--tag', image, root); imageBuilt = true;
    await start('dev'); await start('planner');
    peers.forEach(p => coordinator.register(bindingFor(root, 'docker:fixture', p.id, 'fixture')));
    await coordinator.tick();
    const response = await fetch(`${endpoints.get('dev')}/tasks`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'login', prompt: 'Complete login.' }) });
    expect(response.status).toBe(202);
    await wait(async () => (await task()).status === 'waiting', 'waiting question');
    const original = await task(); expect(original.goal?.phase).toBe('waiting');
    // Kill and remove the exact test container. The named data volume is retained.
    await docker('kill', `${prefix}-dev`); await docker('rm', `${prefix}-dev`); containers.delete(`${prefix}-dev`);
    await coordinator.dispose(); coordinator = relay();
    await start('dev');
    expect((await task()).status).toBe('waiting');
    await wait(async () => { await coordinator.tick(); return (await task()).status === 'completed'; }, 'restored collaboration');
    const completed = await task();
    expect(completed.threadId).toBe(original.threadId);
    expect(completed.goal).toMatchObject({ phase: 'completed', turns: 3 });
    expect(completed.goal?.decisions.map(d => d.action)).toEqual(['wait', 'continue', 'complete']);
    expect(completed.output).toBe('Continued login using the received policy.');
  } finally {
    await coordinator.dispose();
    for (const name of containers) await docker('rm', '--force', name);
    for (const name of volumes) await docker('volume', 'rm', name);
    if (imageBuilt) await docker('image', 'rm', image);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
