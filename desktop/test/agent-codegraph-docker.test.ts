import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SPECIALIST_WORKER_FILES } from '../../scripts/prepare-specialist-worker.mts';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';

const execute = promisify(execFile), context = process.env.CHESHI_CODEGRAPH_DOCKER_CONTEXT;
test.if(Boolean(context))('isolated Docker worker queries host CodeGraph through authenticated orchestration with write and command permissions off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-codegraph-docker-')), name = `cheshi-codegraph-test-${randomUUID()}`, image = `${name}:test`;
  let built = false, created = false, coordinator: ReturnType<typeof createAgentOrchestration> | undefined;
  const docker = async (...args: string[]) => (await execute('docker', ['--context', context!, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  mkdirSync(join(root, 'src'));
  for (const filename of SPECIALIST_WORKER_FILES.filter(f => f.startsWith('src/'))) copyFileSync(fileURLToPath(new URL(`../../experiments/codex-specialists/${filename}`, import.meta.url)), join(root, filename));
  copyFileSync(fileURLToPath(new URL('./fixtures/codegraph-app-server.ts', import.meta.url)), join(root, 'fixture.ts'));
  writeFileSync(join(root, 'codex'), '#!/bin/sh\nexec /usr/local/bin/bun /test/fixture.ts "$@"\n', { mode: 0o755 });
  const token = 'b'.repeat(64);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ codegraphProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development', token,
    revision: 'test', instructions: 'Search the assigned project.', model: null, reasoningEffort: null, serviceTier: null,
    permissions: { fileWrite: false, commandExecution: false } }));
  writeFileSync(join(root, 'Dockerfile'), 'FROM cheshi-specialist:1\nUSER root\nCOPY src /app/src\nCOPY fixture.ts codex config.json /test/\nRUN chmod 755 /test/codex\nUSER node\n');
  const wait = async (check: () => Promise<boolean>) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until) { if (await check()) return; await Bun.sleep(100); }
    throw new Error('Docker CodeGraph test timed out.');
  };
  try {
    await docker('build', '--network=none', '--tag', image, root); built = true;
    await docker('create', '--name', name, '--label', 'ai.cheshi.test=codegraph', '--init', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '64', '--cpus', '1',
      '--tmpfs', '/agent:rw,nosuid,nodev,size=32m,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
      '--publish', '127.0.0.1::8787', '--env', 'PATH=/test:/usr/local/bin:/usr/bin:/bin', '--env', 'AGENT_RUNTIME_CONFIG=/test/config.json',
      '--env', 'AGENT_RUNTIME_REVISION=test', '--env', 'AGENT_DATA_DIRECTORY=/agent', '--env', 'AGENT_WORKSPACE=/app', image);
    created = true; await docker('start', name);
    const endpoint = `http://${await docker('port', name, '8787/tcp')}`;
    await wait(async () => { try { return (await fetch(`${endpoint}/health`)).ok; } catch { return false; } });
    expect((await fetch(`${endpoint}/codegraph/exchange`, { method: 'POST', body: '{}' })).status).toBe(401);
    let queries = 0;
    coordinator = createAgentOrchestration({ filename: join(root, 'mailbox.json'),
      peer: () => ({ id: 'dev', name: 'Developer', role: 'development' }), connect: async () => ({ endpoint, token }),
      codegraph: async (workspace, tool, args) => {
        expect(workspace).toBe(root); expect(tool).toBe('codegraph_explore'); expect(args).toEqual({ query: 'find fixture function', maxFiles: 30 }); queries++;
        return { content: [{ type: 'text', text: 'HOST_CODEGRAPH_RESULT /workspace/src/fixture.ts:1' }] };
      },
    });
    coordinator.register(bindingFor(root, `docker:${context}`, 'dev', 'fixture'));
    const submitted = await fetch(`${endpoint}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: 'query-task', prompt: 'Find the fixture function.' }) });
    expect(submitted.status).toBe(202);
    let output = '';
    await wait(async () => {
      await coordinator!.tick();
      const task = await (await fetch(`${endpoint}/tasks/query-task`)).json() as { status: string; output: string };
      output = task.output; return task.status === 'completed';
    });
    expect(output).toContain('HOST_CODEGRAPH_RESULT'); expect(queries).toBe(1);
  } finally {
    await coordinator?.dispose();
    if (created) await docker('rm', '-f', name);
    if (built) await docker('image', 'rm', image);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
