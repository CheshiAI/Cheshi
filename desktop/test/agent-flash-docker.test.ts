import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSpecialistWorker } from '../../scripts/prepare-specialist-worker.mts';
import { AgentFlashMemory } from '../lib/flash/agent-memory.mts';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { FlashRuntime } from '../lib/flash/runtime.mts';
import { FlashWorkerConnection, flashHttpTransport } from '../lib/agent-orchestration/flash-relay.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { dockerMemoryOwner } from '../lib/flash/docker-archive.mts';
import { fixtureSummary } from './flash-test-helpers.ts';
import { flashSourceTarget } from '../shared/flash-memory.ts';

const context = process.env.CHESHI_FLASH_DOCKER_CONTEXT, execute = promisify(execFile);
test.if(Boolean(context))('real Docker worker searches both native Flash scopes for three spellings, reads quotes and preserves originals after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-flash-docker-')), name = `cheshi-flash-test-${randomUUID()}`, image = `${name}:test`;
  const docker = async (...args: string[]) => (await execute('docker', ['--context', context!, ...args], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const host = new FlashRuntime({ directory: join(root, 'flash-runtime'),
    executable: process.env.CHESHI_FLASH_EXECUTABLE || fileURLToPath(new URL('../../../cheshi-flash/.venv/bin/cheshi-flash', import.meta.url)),
    modelCache: process.env.CHESHI_FLASH_MODEL_CACHE || join(homedir(), 'Library/Caches/CheshiFlash/hub') });
  const binding = bindingFor(root, `docker:${context}`, 'dev', 'fixture'), token = 'b'.repeat(64);
  const memory = new AgentFlashMemory(root, b => b.accountId === 'fixture' && b.agentId === 'dev' && b.workspace === root, host);
  const local = new FlashSessionMemory({ workspace: root, host: { transaction: (op, signal) => host.transaction(op, signal), release: async () => {} }, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [{ id: 'local', profileId: 'fixture', title: 'Local decision', updatedAt: 1 }] }), read: async () => ({ thread: { id: 'local', cwd: root,
      turns: [{ id: 'local-turn', status: 'completed', items: [{ id: 'local-message', type: 'agentMessage', text: '플래시 변경 이유: 프로젝트 결정에 원문 근거를 제시하기 위해서입니다.' }] }] } }) } });
  local.accounts({ activeId: 'fixture', profiles: [{ id: 'fixture', label: 'Fixture', email: 'fixture@example.test', login: { state: 'signed_in', error: null }, usage: { state: 'ready', authenticated: true, plan: null, rateLimits: [], error: null } }] });
  memory.register(root, { memory: local, summarize: fixtureSummary, authenticated: id => local.hasAccount(id), original: target => local.original(target) });
  let built = false, created = false, volume = false, bridge: FlashWorkerConnection | undefined;
  const wait = async (check: () => Promise<boolean>) => { const until = Date.now() + 150_000; while (Date.now() < until) { if (await check()) return; await Bun.sleep(100); } throw new Error('Docker Flash test timed out.'); };
  try {
    await prepareSpecialistWorker(fileURLToPath(new URL('../../experiments/codex-specialists', import.meta.url)), join(root, 'build'));
    const build = join(root, 'build');
    await copyFile(fileURLToPath(new URL('./fixtures/flash-app-server.ts', import.meta.url)), join(build, 'fixture.ts'));
    await writeFile(join(build, 'codex'), '#!/bin/sh\nexec /usr/local/bin/bun /test/fixture.ts "$@"\n', { mode: 0o755 });
    await writeFile(join(build, 'start'), '#!/bin/sh\nmkdir -p /agent/state\nif [ ! -f /agent/state/agent.json ]; then cp /test/seed.json /agent/state/agent.json; fi\nexec bun /app/src/worker.ts\n', { mode: 0o755 });
    await writeFile(join(build, 'seed.json'), JSON.stringify({ version: 1, threadId: null, model: null, tasks: [{ id: 'prior-task', prompt: 'Earlier decision', status: 'completed', createdAt: '2026-01-01', finishedAt: '2026-01-01', threadId: 'prior', turnId: 'prior-turn', output: 'decision', error: null }] }));
    await writeFile(join(build, 'config.json'), JSON.stringify({ flashProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development', token,
      revision: 'test', instructions: 'Recall decisions.', model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false } }));
    await writeFile(join(build, 'Dockerfile'), 'FROM cheshi-specialist:1\nUSER root\nCOPY src /app/src\nCOPY fixture.ts codex start seed.json config.json /test/\nRUN chmod 755 /test/codex /test/start\nUSER node\nENTRYPOINT ["/test/start"]\n');
    await docker('build', '--network=none', '--tag', image, build); built = true;
    await docker('volume', 'create', name); volume = true;
    await docker('create', '--name', name, '--label', 'ai.cheshi.test=flash', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--memory', '256m', '--pids-limit', '64', '--cpus', '1', '--mount', `type=volume,src=${name},dst=/agent`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
      '--publish', '127.0.0.1::8787', '--env', 'PATH=/test:/usr/local/bin:/usr/bin:/bin', '--env', 'AGENT_RUNTIME_CONFIG=/test/config.json', '--env', 'AGENT_RUNTIME_REVISION=test',
      '--env', 'AGENT_DATA_DIRECTORY=/agent', '--env', 'AGENT_WORKSPACE=/app', image);
    created = true; await docker('start', name);
    let endpoint = `http://${await docker('port', name, '8787/tcp')}`;
    await wait(async () => { try { return (await fetch(`${endpoint}/health`)).ok; } catch { return false; } });
    for (const route of ['/flash/history', '/flash/exchange']) expect((await fetch(endpoint + route, { method: 'POST', body: '{}' })).status).toBe(401);
    bridge = new FlashWorkerConnection(memory, binding, flashHttpTransport({ endpoint, token }), () => true, () => {});
    await local.synchronize(); await bridge.flush();
    const submitted = await fetch(`${endpoint}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: 'query-task', prompt: 'Why did we change Flash?' }) });
    expect(submitted.status).toBe(202);
    let output = '';
    await wait(async () => { await bridge!.tick(); const task = await (await fetch(`${endpoint}/tasks/query-task`)).json() as { status: string; output: string }; output = task.output; return task.status === 'completed'; });
    const results = output.trim().split('\n').map(line => JSON.parse(line));
    expect(results).toHaveLength(4);
    for (const found of results.slice(0, 3)) { expect(found.partial).toBe(false); expect(new Set(found.matches.map((m: { origin: string }) => m.origin))).toEqual(new Set(['docker', 'local'])); }
    const evidence = results[3].results.find((r: { origin: string }) => r.origin === 'docker').evidence[0];
    const target = flashSourceTarget(evidence.source_url)!;
    expect(await memory.original(root, target)).toBe(evidence.quote);
    await bridge.flush(); await bridge.dispose(); bridge = undefined;
    await docker('restart', name); endpoint = `http://${await docker('port', name, '8787/tcp')}`;
    await wait(async () => { try { return (await fetch(`${endpoint}/health`)).ok; } catch { return false; } });
    bridge = new FlashWorkerConnection(memory, binding, flashHttpTransport({ endpoint, token }), () => true, () => {});
    await bridge.flush();
    expect((await memory.archive.sources(dockerMemoryOwner(binding))).sources.some(s => s.document.itemId === 'answer')).toBe(true);
    expect(await memory.original(root, target)).toBe(evidence.quote);
  } finally {
    await bridge?.dispose(); await local.dispose(); await memory.dispose();
    if (created) await docker('rm', '-f', name);
    if (volume) await docker('volume', 'rm', name);
    if (built) await docker('image', 'rm', image);
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
