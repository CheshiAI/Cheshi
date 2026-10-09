import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpecialistRuntime } from '../lib/agent-management/runtime.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { WorkerWorkspaces } from '../lib/agent-platform/worker-workspaces.mts';
import { git, revision } from '../lib/agent-platform/git-workspaces.mts';
import { runDocker, type DockerCommand } from '../lib/agent-management/docker.mts';
import type { AgentDetails } from '../shared/agent-management.ts';
import { specialistInput } from './agent-registry-fixtures.ts';
import { assertFailure } from './agent-platform-fixtures.ts';

async function fixture(realContext?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-worker-runtime-')));
  const source = join(root, 'source'), home = join(root, 'account'); mkdirSync(source); mkdirSync(home);
  await git(source, ['init', '-b', 'main']);
  writeFileSync(join(source, 'file.txt'), 'baseline');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', '[test] fixture']);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only', refresh_token: 'test-only', id_token: 'test-only', account_id: 'fixture' } }));
  const registry = createAgentRegistry(join(root, 'registry.json')), input = specialistInput();
  input.profile.accountId = 'default'; input.profile.permissions = { fileWrite: true, commandExecution: true };
  const agentId = registry.save(input, source).agentId, engineId = `docker:${realContext ?? 'test'}`;
  const id = 'a'.repeat(64), calls: string[][] = [], prepared: string[] = [];
  const installedInstructions: string[] = [];
  let created = false, labels: Record<string, string> = {}, configured = false;
  const details: AgentDetails = { agent: { id, name: 'Homie', image: 'worker', state: 'running' }, ready: true, busy: false,
    authenticated: true, threadId: null, error: null, logs: '', tasks: [] };
  const run: DockerCommand = async (args, stdin) => {
    calls.push(args);
    if (realContext) {
      if (args[2] === 'build') return ''; // Use the installed worker image; no network or model requests.
      if (args[2] === 'container' && args[3] === 'create') {
        const result = await runDocker([...args.slice(0, -1), '--entrypoint', 'bun', args.at(-1)!, '-e', 'setInterval(()=>{},1000)'], stdin);
        details.agent.id = result.trim(); return result;
      }
      return runDocker(args, stdin);
    }
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///fixture/docker.sock' } } }]);
    if (args[2] === 'exec') {
      if (stdin) {
        configured = true;
        const { configuration } = JSON.parse(stdin);
        if (configuration) installedInstructions.push(configuration.instructions);
      }
      if (args.at(-1)?.includes('createHash')) return createHash('sha256').update('fixture').digest('hex');
      return configured ? 'configured' : 'pending';
    }
    if (args[2] !== 'container') return '';
    if (args[3] === 'ls') return created ? id : '';
    if (args[3] === 'inspect') return JSON.stringify([{ Id: id, Name: '/worker', ExecIDs: null, Config: { Image: 'worker', Labels: labels },
      State: { Status: details.agent.state }, NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '49999' }] } } }]);
    if (args[3] === 'create') {
      created = true; labels = {};
      args.forEach((arg, index) => { if (arg === '--label') { const [key, value] = args[index + 1]!.split('='); labels[key!] = value!; } });
    }
    if (args[3] === 'rm') created = false;
    return id;
  };
  const options = { directory: join(root, 'runtime'), workspaceDirectory: join(root, 'platform'),
    buildContext: fileURLToPath(new URL('../../experiments/codex-specialists', import.meta.url)), registry, run,
    checkProjectEnvironment: async (_engine: string, _prefix: string[], workspace: string) => { prepared.push(workspace); },
    prepareCodeGraph: async (workspace: string) => { prepared.push(workspace); },
    collaborationExchange: async () => ({ protocol: 1, received: [], outgoing: [] }),
    lifecycleControl: async () => ({ protocol: 1, idle: false, nextWakeAt: null }),
    account: async () => ({ home, models: [] }), management: { details: async () => details,
      engines: async () => ({ engines: [], error: null }), snapshot: async () => ({ engineId, online: true, error: null, agents: [] }),
      control: async (): Promise<never> => { throw new Error('unused'); } } };
  const runtime = createSpecialistRuntime(options);
  const identity = { workspace: source, agentId, engineId, accountId: 'default' };
  return { root, source, calls, details, prepared, installedInstructions, options, runtime, identity,
    input: { agentId, engineId }, dispose: async () => { await runtime.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('Worker start and follow-up use the retained worktree, private data volume and protected Git link', async () => {
  const f = await fixture();
  const posts: { url: string; body: unknown }[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/workspace/prepare')) return Response.json({ pending: null });
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await f.runtime.request(f.source, { ...f.input, action: 'start' });
    const saved = await new WorkerWorkspaces(f.options.workspaceDirectory).existing(f.identity);
    expect(saved).not.toBeNull();
    const created = f.calls.find(args => args[3] === 'create')!;
    const mounts = created.flatMap((arg, i) => arg === '--mount' ? [created[i + 1]!] : []);
    expect(mounts).toHaveLength(3);
    expect(mounts).toContain(`type=bind,src=${saved!.workspace},dst=/workspace`);
    expect(mounts).toContain(`type=bind,src=${saved!.workspace}/.git,dst=/workspace/.git,readonly`);
    expect(mounts.some(mount => mount.includes(`src=${f.source},`))).toBe(false);
    expect(created[created.indexOf('--user') + 1]).toBe(`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
    const initialization = f.calls.find(args => args[2] === 'run')!;
    expect(initialization).toContain('none'); expect(initialization.some(value => value.includes('type=bind'))).toBe(false);
    writeFileSync(join(saved!.workspace, 'file.txt'), 'first change');
    const context = { roomId: 'room', conversation: 'task', goal: false, automatic: true as const, userText: 'continue' };
    await f.runtime.chat(f.source, { ...f.input, action: 'submit', taskId: 'task', prompt: 'first' }, context);
    await f.runtime.chat(f.source, { ...f.input, action: 'submit', taskId: 'task', prompt: 'follow-up' }, { ...context, inputId: 'follow-up' });
    expect(posts.map(post => post.url)).toEqual(['http://127.0.0.1:49999/tasks', 'http://127.0.0.1:49999/tasks/task/input']);
    expect(f.prepared.every(path => path === saved!.workspace)).toBe(true);
    await f.runtime.dispose();
    const reopened = createSpecialistRuntime(f.options);
    try { await reopened.request(f.source, { ...f.input, action: 'start' }); }
    finally { await reopened.dispose(); }
    expect(f.calls.filter(args => args[3] === 'create')).toHaveLength(1);
    expect(readFileSync(join(saved!.workspace, 'file.txt'), 'utf8')).toBe('first change');
    expect(readFileSync(join(f.source, 'file.txt'), 'utf8')).toBe('baseline');
  } finally { fetch.mockRestore(); await f.dispose(); }
});

test.each([true, false])('Git limitations and file verification guidance reach only isolated workers: isolated=%s', async isolated => {
  const f = await fixture();
  await f.runtime.dispose();
  const runtime = createSpecialistRuntime({ ...f.options, workspaceDirectory: isolated ? f.options.workspaceDirectory : undefined });
  try {
    await runtime.request(f.source, { ...f.input, action: 'start' });
    expect(f.installedInstructions).toHaveLength(1);
    const instructions = f.installedInstructions[0]!;
    expect(instructions).toContain('Implement approved changes and verify them.');
    expect(instructions).toContain('Follow this project’s AGENTS.md.');
    const guidance = [
      'Git metadata is intentionally not mounted',
      'git status, git diff and git log, are unavailable',
      'Do not run repository Git commands, repair .git, initialize a replacement repository',
      'reading the affected files directly and running the relevant available tests',
      'A Git metadata path error alone does not indicate missing file permissions, repository corruption or task failure',
      'Do not claim a Git status or diff check passed when it was unavailable',
    ];
    for (const text of guidance) expect(instructions.includes(text)).toBe(isolated);
  } finally { await runtime.dispose(); await f.dispose(); }
});

const context = process.env.CHESHI_PLATFORM_DOCKER_CONTEXT;
test.if(Boolean(context))('real Worker mounts support native sandbox writes and preserve private data across restart', async () => {
  const f = await fixture(context);
  try {
    await f.runtime.request(f.source, { ...f.input, action: 'start' });
    const saved = await new WorkerWorkspaces(f.options.workspaceDirectory).existing(f.identity);
    const prefix = ['--context', context!], id = f.details.agent.id;
    const program = `const fs=require('node:fs'),assert=require('node:assert/strict');
      assert(!fs.existsSync(fs.readFileSync('/workspace/.git','utf8').trim().slice(8)));
      assert(!fs.existsSync('/var/run/docker.sock'));
      assert.throws(()=>fs.writeFileSync('/workspace/.git','bad'));
      assert.throws(()=>fs.writeFileSync('/agent/runtime.json','bad'));
      fs.writeFileSync('/workspace/file.txt','sandbox change');console.log('WORKER_SANDBOX_PASSED');`;
    const output = await runDocker([...prefix, 'exec', '--workdir', '/workspace', id, 'codex', 'sandbox', '-P', ':workspace', '-C', '/workspace', '--', 'node', '-e', program]);
    expect(output).toContain('WORKER_SANDBOX_PASSED');
    await runDocker([...prefix, 'exec', id, 'bun', '-e', "require('node:fs').writeFileSync('/agent/state/retained.txt','retained')"]);
    await runDocker([...prefix, 'container', 'restart', id]);
    expect(await runDocker([...prefix, 'exec', id, 'bun', '-e', "process.stdout.write(require('node:fs').readFileSync('/agent/state/retained.txt','utf8'))"])).toBe('retained');
    expect(readFileSync(join(saved!.workspace, 'file.txt'), 'utf8')).toBe('sandbox change');
    expect(readFileSync(join(f.source, 'file.txt'), 'utf8')).toBe('baseline');
  } finally {
    await f.runtime.dispose();
    if (f.details.agent.id !== 'a'.repeat(64)) await runDocker(['--context', context!, 'container', 'rm', '--force', f.details.agent.id]);
    const create = f.calls.find(args => args[3] === 'create');
    const volume = create?.find(arg => arg.startsWith('type=volume,src=cheshi-agent-'))?.split(',')[1]?.slice(4);
    if (volume) await runDocker(['--context', context!, 'volume', 'rm', volume]);
    await f.dispose();
  }
}, 60_000);

test('legacy workers cannot dispatch on the source mount and unknown stopped work prevents migration', async () => {
  const f = await fixture();
  await f.runtime.dispose();
  const legacy = createSpecialistRuntime({ ...f.options, workspaceDirectory: undefined });
  try {
    await legacy.request(f.source, { ...f.input, action: 'start' });
    await legacy.dispose();
    const runtime = createSpecialistRuntime(f.options);
    try {
      await assertFailure(runtime.chat(f.source, { ...f.input, action: 'submit', taskId: 'new', prompt: 'work' },
        { roomId: 'room', conversation: 'new', goal: false, automatic: true }), /Settings changed/);
      f.details.agent.state = 'exited';
      f.details.tasks = [{ id: 'old', prompt: 'unfinished', status: 'unknown', output: '', error: null, createdAt: new Date().toISOString() }];
      await assertFailure(runtime.request(f.source, { ...f.input, action: 'start' }), /unfinished execution/);
      expect(f.calls.some(args => args[3] === 'rm')).toBe(false);
      f.details.tasks[0]!.status = 'completed';
      f.details.agent.state = 'running';
      await runtime.request(f.source, { ...f.input, action: 'start' });
      const created = f.calls.filter(args => args[3] === 'create');
      expect(created).toHaveLength(2);
      expect(created[1]!.some(arg => arg === `type=bind,src=${f.source},dst=/workspace`)).toBe(false);
      const volume = (args: string[]) => args.find(arg => arg.startsWith('type=volume,src=cheshi-agent-'));
      expect(volume(created[1]!)).toBe(volume(created[0]!));
    } finally { await runtime.dispose(); }
  } finally { await legacy.dispose(); await f.dispose(); }
});

async function exerciseTaskSwitch(realContext?: string) {
  const f = await fixture(realContext);
  let pending: { taskId: string; key: string } | null = null;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/workspace/prepare')) { const next = pending; pending = null; return Response.json({ pending: next }); }
    return Response.json({});
  }, { preconnect: globalThis.fetch.preconnect }));
  const manager = new WorkerWorkspaces(f.options.workspaceDirectory);
  const switchTo = async (taskId: string, key = taskId) => {
    pending = { taskId, key };
    await f.runtime.request(f.source, { ...f.input, action: 'start' });
    const saved = await manager.existing(f.identity, key === '@intake' ? `@intake:${await revision(f.source, 'HEAD')}` : key);
    expect(saved).not.toBeNull();
    const created = f.calls.filter(args => args[3] === 'create').at(-1)!;
    expect(created).toContain(`type=bind,src=${saved!.workspace},dst=/workspace${key === '@intake' ? ',readonly' : ''}`);
    expect(created).toContain(`type=bind,src=${saved!.workspace}/.git,dst=/workspace/.git,readonly`);
    expect(created.some(arg => arg === `type=bind,src=${f.source},dst=/workspace`)).toBe(false);
    return saved!;
  };
  try {
    const intake = await switchTo('first', '@intake');
    expect(await manager.existing(f.identity, 'first')).toBeNull();
    expect(await manager.forTask(f.identity, 'first')).toEqual(intake);
    if (realContext) {
      const output = await runDocker(['--context', realContext, 'exec', f.details.agent.id, 'node', '-e',
        "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('/workspace/file.txt','utf8'),'baseline');a.throws(()=>f.writeFileSync('/workspace/file.txt','forbidden'));console.log('INTAKE_READ_ONLY')"]);
      expect(output).toContain('INTAKE_READ_ONLY');
    }
    const first = await switchTo('first');
    expect(intake.workspace).not.toBe(first.workspace);
    writeFileSync(join(first.workspace, 'first.txt'), 'retained first');
    writeFileSync(join(f.source, 'file.txt'), 'advanced');
    await git(f.source, ['add', '.']); await git(f.source, ['commit', '-m', '[test] advance source']);
    const second = await switchTo('second');
    expect(second.baseCommit).not.toBe(first.baseCommit);
    if (realContext) {
      const output = await runDocker(['--context', realContext, 'exec', f.details.agent.id, 'node', '-e',
        "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.existsSync('/workspace/first.txt'),false);console.log('TASKS_SEPARATE')"]);
      expect(output).toContain('TASKS_SEPARATE');
    }
    expect(readFileSync(join(second.workspace, 'file.txt'), 'utf8')).toBe('advanced');
    expect(await switchTo('first')).toEqual(first);
    expect(readFileSync(join(first.workspace, 'first.txt'), 'utf8')).toBe('retained first');
    expect(readFileSync(join(first.workspace, 'file.txt'), 'utf8')).toBe('baseline');
    const creations = f.calls.filter(args => args[3] === 'create');
    const volumes = creations.map(args => args.find(arg => arg.startsWith('type=volume,src=cheshi-agent-')));
    expect(new Set(volumes).size).toBe(1);
    const count = creations.length;
    await f.runtime.request(f.source, { ...f.input, action: 'start' });
    expect(f.calls.filter(args => args[3] === 'create')).toHaveLength(count);
    if (realContext) {
      const result = await runDocker(['--context', realContext, 'exec', '--workdir', '/workspace', f.details.agent.id,
        'codex', 'sandbox', '-P', ':workspace', '-C', '/workspace', '--', 'node', '-e',
        "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('/workspace/first.txt','utf8'),'retained first');a.equal(f.readFileSync('/workspace/file.txt','utf8'),'baseline');a.throws(()=>f.writeFileSync('/workspace/.git','bad'));f.writeFileSync('/workspace/followup.txt','followup');console.log('TASK_SWITCH_PASSED')"]);
      expect(result).toContain('TASK_SWITCH_PASSED');
      expect(readFileSync(join(first.workspace, 'followup.txt'), 'utf8')).toBe('followup');
    }
  } finally {
    fetch.mockRestore(); await f.runtime.dispose();
    if (realContext) {
      if (f.details.agent.id !== 'a'.repeat(64)) await runDocker(['--context', realContext, 'container', 'rm', '--force', f.details.agent.id]);
      const create = f.calls.find(args => args[3] === 'create');
      const volume = create?.find(arg => arg.startsWith('type=volume,src=cheshi-agent-'))?.split(',')[1]?.slice(4);
      if (volume) await runDocker(['--context', realContext, 'volume', 'rm', volume]);
    }
    await f.dispose();
  }
}

test('task transitions replace only the container mount, preserve its volume, and retain task-specific baselines', () => exerciseTaskSwitch(), 30_000);
test.if(Boolean(context))('real Docker switches independent task worktrees and resumes the original sandbox', () => exerciseTaskSwitch(context), 90_000);
