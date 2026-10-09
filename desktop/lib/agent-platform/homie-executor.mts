import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeConfiguration } from '../../../experiments/codex-specialists/src/runtime-config.ts';
import { redactAgentLogs, runDocker, type DockerCommand } from '../agent-management/docker.mts';
import { executionPlan, identifier, imageId, record, type ExecutionReceipt, type ExecutionRequest } from './contracts.mts';

export interface HomieExecutionProfile {
  agentId: string;
  accountId: string;
  configuration: Omit<RuntimeConfiguration, 'token'>;
  /** Recheck assignment and settings before using the chosen account. Never persist this value on the host. */
  credentials(): Promise<string>;
  assertCurrent(): void;
}
export interface HomieProgress { sessionId: string | null; output: string }
const label = 'ai.cheshi.platform-homie';
const nameFor = (id: string) => `cheshi-platform-homie-${identifier(id)}`;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const install = "const fs=require('node:fs');const v=JSON.parse(await Bun.stdin.text());fs.mkdirSync('/agent/codex',{recursive:true});fs.writeFileSync('/agent/codex/auth.json',v.auth,{mode:0o600});fs.writeFileSync('/agent/runtime.json.tmp',JSON.stringify(v.configuration),{mode:0o600});fs.renameSync('/agent/runtime.json.tmp','/agent/runtime.json');";
const exchangeScript = "const r=JSON.parse(await Bun.stdin.text());const response=await fetch('http://127.0.0.1:8787'+r.route,{method:r.body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+r.token},...(r.body===undefined?{}:{body:JSON.stringify(r.body)}),signal:AbortSignal.timeout(10000)});console.log(JSON.stringify({status:response.status,body:await response.json()}));";

/** A task-specific instance of the existing Homie worker. Only this worktree is bind-mounted. */
export async function createHomieExecutor(options: {
  engineId: string; buildContext: string; profile?: HomieExecutionProfile;
  changed?(progress: HomieProgress): void;
  run?: DockerCommand; pollMs?: number;
}) {
  const run = options.run ?? runDocker;
  if (!/^docker:[a-zA-Z0-9_.-]+$/.test(options.engineId)) throw new Error('Select a local Docker engine.');
  const contexts: unknown = JSON.parse(await run(['context', 'inspect', options.engineId.slice(7)]));
  if (!Array.isArray(contexts) || contexts.length !== 1) throw new Error('Invalid Docker context.');
  const host = record(record(record(contexts[0]).Endpoints).docker).Host;
  if (typeof host !== 'string' || !host.startsWith('unix:///')) throw new Error('Only local Docker engines are supported.');
  const prefix = ['--host', host];
  async function inspect(id: string) {
    const name = nameFor(id);
    const found = (await run([...prefix, 'container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).trim();
    if (!found) return null;
    if (!/^[a-f0-9]{64}$/.test(found)) throw new Error('Ambiguous task container identity.');
    const values: unknown = JSON.parse(await run([...prefix, 'container', 'inspect', found]));
    if (!Array.isArray(values) || values.length !== 1) throw new Error('Invalid task container.');
    const raw = record(values[0]);
    if (raw.Id !== found || raw.Name !== `/${name}` || record(record(raw.Config).Labels)[label] !== id) throw new Error('Task container ownership changed.');
    return { id: found, image: imageId(raw.Image), status: String(record(raw.State).Status) };
  }
  async function stop(id: string, expected: string, image: string) {
    const current = await inspect(id);
    assertContainer(current, expected, image);
    if (!['exited', 'dead', 'created'].includes(current!.status)) await run([...prefix, 'container', 'stop', '--time', '10', expected]);
    const stopped = await inspect(id);
    assertContainer(stopped, expected, image);
    if (!['exited', 'dead', 'created'].includes(stopped!.status)) throw new Error('Task container has not stopped. Outcome is unknown.');
  }
  return {
    identity: `homie-v1:${host}`,
    async inspect(id: string): Promise<'running' | 'stopped' | 'missing'> {
      const current = await inspect(id);
      return !current ? 'missing' : ['exited', 'dead'].includes(current.status) ? 'stopped' : 'running';
    },
    async cleanup(id: string) {
      const current = await inspect(id);
      if (!current) return;
      if (!['exited', 'dead', 'created'].includes(current.status)) throw new Error('Stop the task before cleanup.');
      await run([...prefix, 'container', 'rm', current.id]);
    },
    async execute(input: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionReceipt> {
      const plan = executionPlan(input), id = identifier(input.id), profile = options.profile;
      if (!profile || input.writable !== true || input.task?.assignee !== profile.agentId
        || profile.configuration.permissions.fileWrite !== true || profile.configuration.permissions.commandExecution !== true) throw new Error('This isolated task exceeds its saved Homie permissions.');
      profile.assertCurrent(); signal?.throwIfAborted();
      const prompt = `${input.task.goal}\n\nReason: ${input.task.reason}\nAcceptance criteria:\n${input.task.criteria.join('\n')}\nAllowed change paths:\n${input.task.scope.join('\n')}\nWork only in /workspace. Host Cheshi owns Git commits and merging. Do not modify .git or run Git operations. Finish with a concise explanation of the changes and tests.`;
      if (JSON.stringify({ id, prompt }).length > 25_000) throw new Error('Task context is too large. Shorten the instructions or allowed paths.');
      const workspace = await realpath(input.workspace);
      if (/[,\r\n]/.test(workspace) || !(await lstat(join(workspace, '.git'))).isFile()) throw new Error('Use a linked worktree for isolated tasks.');
      if (await inspect(id)) throw new Error('This task already has a container. Inspect its outcome before any new execution.');
      const token = randomBytes(32).toString('hex');
      const configuration: RuntimeConfiguration = { ...profile.configuration, token };
      const revision = randomBytes(32).toString('hex');
      const security = ['--security-opt', `seccomp=${join(options.buildContext, 'security', 'codex-bwrap.json')}`];
      if (options.engineId.startsWith('docker:colima')) security.push('--security-opt', 'apparmor=cheshi-codex-bwrap');
      const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
      const startedAt = new Date().toISOString();
      const rawId = (await run([...prefix, 'container', 'create', '--name', nameFor(id), '--pull', 'never',
        '--label', `${label}=${id}`, '--read-only', '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...security,
        '--user', `${uid}:${gid}`, '--cpus', String(plan.cpus), '--memory', `${plan.memoryMb}m`, '--pids-limit', '256',
        '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
        '--mount', `type=bind,src=${workspace},dst=/workspace`,
        '--mount', `type=bind,src=${join(workspace, '.git')},dst=/workspace/.git,readonly`,
        '--tmpfs', `/agent:rw,nosuid,nodev,size=256m,mode=0700,uid=${uid},gid=${gid}`,
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--workdir', '/app',
        '--env', 'CODEX_HOME=/agent/codex', '--env', 'AGENT_DATA_DIRECTORY=/agent', '--env', 'AGENT_WORKSPACE=/workspace',
        '--env', 'AGENT_RUNTIME_CONFIG=/agent/runtime.json', '--env', `AGENT_RUNTIME_REVISION=${revision}`,
        '--entrypoint', 'bun', plan.image, 'src/worker.ts'])).trim();
      assertContainer(await inspect(id), rawId, plan.image);
      async function exchange(route: string, body?: unknown) {
        assertContainer(await inspect(id), rawId, plan.image);
        const response = record(JSON.parse(await run([...prefix, 'exec', '--interactive', rawId, 'bun', '-e', exchangeScript],
          JSON.stringify({ route, token, ...(body === undefined ? {} : { body }) }))));
        if (response.status !== 200 && response.status !== 202) throw new Error('Homie worker did not confirm the request. Inspect the retained task.');
        return record(response.body);
      }
      let stopped = false;
      try {
        const auth = await profile.credentials();
        profile.assertCurrent(); signal?.throwIfAborted();
        await run([...prefix, 'container', 'start', rawId]);
        await run([...prefix, 'exec', '--interactive', rawId, 'bun', '-e', install], JSON.stringify({ auth, configuration: { ...configuration, revision } }));
        const deadline = Date.now() + plan.timeoutMs;
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          signal?.throwIfAborted();
          try { ready = (await exchange('/health')).ready === true; } catch { /* The worker has not opened its loopback listener yet. */ }
          if (ready) break;
          await delay(options.pollMs ?? 1000);
        }
        assertReady(ready);
        assertAuthenticated((await exchange('/account')).authenticated);
        profile.assertCurrent();
        const accepted = await exchange('/tasks', { id, prompt });
        assertTask(accepted, id);
        for (;;) {
          signal?.throwIfAborted(); profile.assertCurrent();
          const task = await exchange(`/tasks/${id}`); assertTask(task, id);
          const sessionId = typeof task.threadId === 'string' ? task.threadId : null;
          const output = redactAgentLogs(typeof task.output === 'string' ? task.output : '');
          options.changed?.({ sessionId, output });
          if (['completed', 'failed', 'interrupted'].includes(String(task.status))) {
            assertFinishedTask(task, sessionId);
            // Stop all processes before the host snapshots or commits any worker changes.
            await stop(id, rawId, plan.image); stopped = true;
            return { id, image: plan.image, exitCode: task.status === 'completed' ? 0 : 1,
              output: redactAgentLogs(`${output}${task.error ? `\n${String(task.error)}` : ''}`), startedAt, finishedAt: new Date().toISOString(),
              ...(sessionId ? { session: { threadId: sessionId, agentId: profile.agentId, accountId: profile.accountId, model: configuration.model } } : {}) };
          }
          assertContinuing(task, Date.now() < deadline);
          await delay(options.pollMs ?? 1000);
        }
      } finally {
        // No retry or fabricated completion after transport loss. Stopping also discards the tmpfs credentials.
        if (!stopped) await stop(id, rawId, plan.image);
      }
    },
  };
}
function assertContainer(current: { id: string; image: string } | null, id: string, image: string): void {
  if (!/^[a-f0-9]{64}$/.test(id) || !current || current.id !== id || current.image !== image) throw new Error('Task container identity changed.');
}
function assertReady(ready: boolean): void { if (!ready) throw new Error('Homie worker did not become ready. Check the local worker image.'); }
function assertTask(task: Record<string, unknown>, id: string): void {
  if (task.id !== id || typeof task.status !== 'string') throw new Error('Worker returned another task identity.');
}
function assertFinishedTask(task: Record<string, unknown>, sessionId: string | null): void {
  if (task.status === 'completed' && (!sessionId || task.error != null)) throw new Error('Worker completion is missing session evidence.');
}
function assertContinuing(task: Record<string, unknown>, inTime: boolean): void {
  if (!inTime) throw new Error('Homie task timed out. Execution remains unknown; inspect its saved output.');
  if (!['accepted', 'running'].includes(String(task.status))) throw new Error('Homie task is waiting or has an unknown outcome. Inspect it before starting another task.');
}

function assertAuthenticated(value: unknown): void {
  if (value !== true) throw new Error('The selected Homie account is not authenticated.');
}
