import { expect, test } from 'bun:test';
import { createWorktree, worktreeLocation } from '../lib/agent-platform/managed-worktrees.mts';
import { revision } from '../lib/agent-platform/git-workspaces.mts';
import { createPlatformDockerExecutor } from '../lib/agent-management/platform-executor.mts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';
import type { ExecutionPermissions } from '../shared/agent-registry.ts';
import { assertFailure, fixture, plan, taskInput } from './agent-platform-fixtures.ts';

function dockerFixture(options: { running?: boolean; foreign?: boolean } = {}) {
  const calls: string[][] = [], id = 'b'.repeat(64);
  let created = false, running = options.running === true, runId = '';
  const run: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///fixture/docker.sock' } } }]);
    expect(args.slice(0, 2)).toEqual(['--host', 'unix:///fixture/docker.sock']);
    const command = args[3];
    if (args[2] === 'image') return plan.image;
    if (command === 'ls') return created ? id : '';
    if (command === 'create') { created = true; runId = args[args.indexOf('--name') + 1]!.slice('cheshi-platform-'.length); return id; }
    if (command === 'inspect') return JSON.stringify([{ Id: id, Image: plan.image, Name: `/cheshi-platform-${runId}`,
      Config: { Labels: { 'ai.cheshi.platform-run': options.foreign ? 'another-run' : runId } }, State: { Status: running ? 'running' : 'exited', ExitCode: running ? 0 : 0 } }]);
    if (command === 'logs') return 'ok';
    if (command === 'kill') { running = false; return id; }
    if (command === 'rm') { created = false; return id; }
    if (command === 'start') return id;
    throw new Error(`Unexpected Docker operation ${args[2]} ${command}`);
  };
  return { calls, run };
}

async function prepareWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
  const location = worktreeLocation(f.directory, 'task', 'docker-fixture');
  await createWorktree(f.directory, f.repository, await revision(f.repository, 'HEAD'), location);
  return location.workspace;
}

test('Docker runs pin the local engine and image, isolate Git metadata, and honor literal permissions', async () => {
  const mock = dockerFixture();
  const docker = await createPlatformDockerExecutor({ engineId: 'docker:test', permissions: { fileWrite: true, commandExecution: true }, run: mock.run });
  const f = await fixture(docker);
  try {
    const workspace = await prepareWorkspace(f);
    expect(await docker.resolveImage('fixture:1')).toBe(plan.image);
    await assertFailure(docker.execute({ ...plan, id: 'source', workspace: f.repository, writable: true }), /linked worktree/);
    const result = await docker.execute({ ...plan, id: 'isolated', workspace, writable: true });
    expect(result.exitCode).toBe(0);
    const args = mock.calls.find(c => c[3] === 'create')!;
    expect(args).toContain('--read-only'); expect(args).toContain('--network'); expect(args).toContain('none');
    expect(args).toContain('--cap-drop'); expect(args).toContain('ALL');
    expect(args).toContain(`type=bind,src=${workspace}/.git,dst=/workspace/.git,readonly`);
    const mounts = args.flatMap((arg, i) => arg === '--mount' ? [args[i + 1]] : []);
    expect(mounts).toEqual([`type=bind,src=${workspace},dst=/workspace`, `type=bind,src=${workspace}/.git,dst=/workspace/.git,readonly`]);
    expect(args).toContain(plan.image); expect(args).not.toContain('/var/run/docker.sock');
    expect(args).toContain('--memory'); expect(args).toContain('--pids-limit');
    await assertFailure(docker.execute({ ...plan, id: 'isolated', workspace, writable: true }), /already owns/);
    await docker.cleanup('isolated');
    const invalidPermissions: ExecutionPermissions = { commandExecution: true, fileWrite: 1 } as unknown as ExecutionPermissions;
    const forbidden = await createPlatformDockerExecutor({ engineId: 'docker:test', permissions: invalidPermissions, run: mock.run });
    await assertFailure(forbidden.execute({ ...plan, id: 'forbidden', workspace, writable: true }), /permissions/);
  } finally { f.dispose(); }
});

test('verification mounts are read-only, timeout kills only the owned container and never passes', async () => {
  const mock = dockerFixture({ running: true });
  const docker = await createPlatformDockerExecutor({ engineId: 'docker:test', permissions: { fileWrite: false, commandExecution: true }, run: mock.run, pollMs: 1 });
  const f = await fixture(docker);
  try {
    const workspace = await prepareWorkspace(f);
    const result = await docker.execute({ ...plan, timeoutMs: 100, id: 'timeout', workspace, writable: false });
    expect(result.exitCode).toBe(137);
    expect(mock.calls.find(c => c[3] === 'create')).toContain(`type=bind,src=${workspace},dst=/workspace,readonly`);
    expect(mock.calls.filter(c => c[3] === 'kill')).toEqual([['--host', 'unix:///fixture/docker.sock', 'container', 'kill', 'b'.repeat(64)]]);
    await docker.cleanup('timeout');
  } finally { f.dispose(); }
});

test('remote engines and changed ownership are rejected before container start', async () => {
  const remote: DockerCommand = async () => JSON.stringify([{ Endpoints: { docker: { Host: 'tcp://remote:2375' } } }]);
  await assertFailure(createPlatformDockerExecutor({ engineId: 'docker:remote', permissions: { fileWrite: true, commandExecution: true }, run: remote }), /local Docker/);
  const mock = dockerFixture({ foreign: true });
  const docker = await createPlatformDockerExecutor({ engineId: 'docker:test', permissions: { fileWrite: true, commandExecution: true }, run: mock.run });
  const f = await fixture(docker);
  try {
    const workspace = await prepareWorkspace(f);
    await assertFailure(docker.execute({ ...plan, id: 'foreign', workspace, writable: true }), /ownership/);
    expect(mock.calls.some(c => c[3] === 'start')).toBe(false);
  } finally { f.dispose(); }
});

const context = process.env.CHESHI_PLATFORM_DOCKER_CONTEXT;
test.if(Boolean(context))('real Docker workers create isolated changes and verify the exact combined Git candidate', async () => {
  const docker = await createPlatformDockerExecutor({ engineId: `docker:${context}`, permissions: { fileWrite: true, commandExecution: true } });
  const image = await docker.resolveImage('cheshi-specialist:1');
  const f = await fixture(docker);
  try {
    for (const id of ['alpha', 'beta']) f.platform.enqueue({ ...taskInput(id), execution: { ...plan, image,
      command: ['bun', '-e', `const fs=require('node:fs');
        const hostGit=fs.readFileSync('.git','utf8').trim().slice(8);
        if(fs.existsSync(hostGit)||fs.existsSync('/var/run/docker.sock'))throw Error('host access');
        for(const mutate of [()=>fs.writeFileSync('.git','bad'),()=>fs.unlinkSync('.git'),()=>fs.renameSync('.git','stolen')]){
          let blocked=false;try{mutate()}catch{blocked=true}if(!blocked)throw Error('writable git link');
        }
        if(fs.existsSync('${id === 'alpha' ? 'beta' : 'alpha'}.txt'))throw Error('sibling files');
        fs.writeFileSync('${id}.txt', '${id}');`] } });
    expect((await Promise.all(['alpha', 'beta'].map(id => f.platform.runTask(id)))).map(t => t.status)).toEqual(['succeeded', 'succeeded']);
    const candidate = await f.platform.prepareCandidate(['alpha', 'beta'], [{ ...plan, image, command: ['bun', '-e',
      "const f=require('node:fs');for(const id of ['alpha','beta'])if(f.readFileSync(id+'.txt','utf8')!==id)throw Error('missing change');let blocked=false;try{f.writeFileSync('alpha.txt','bad')}catch{blocked=true}if(!blocked)throw Error('writable verification');console.log('combined candidate verified');"] }]);
    expect((await f.platform.verifyCandidate(candidate.id)).status).toBe('passed');
    expect((await f.platform.publication(candidate.id)).checks[0]!.receipt!.output).toContain('combined candidate verified');
  } finally {
    const state = f.platform.snapshot();
    for (const t of state.tasks) for (const a of t.attempts) await docker.cleanup(a.id);
    for (const c of state.candidates) for (const check of c.checks) await docker.cleanup(check.id);
    f.dispose();
  }
}, 90_000);
