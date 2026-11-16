import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionPermissions } from '../../shared/agent-registry.ts';
import { executionPlan, identifier, imageId, record, type ExecutionReceipt, type ExecutionRequest, type PlatformExecutor } from '../agent-platform/contracts.mts';
import { redactAgentLogs, runDocker, type DockerCommand } from './docker.mts';

const label = 'ai.cheshi.platform-run';
const containerName = (id: string) => `cheshi-platform-${identifier(id)}`;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Uses the same local Docker transport as Homies; it never inherits their credentials or project mounts. */
export async function createPlatformDockerExecutor(options: {
  engineId: string;
  permissions: ExecutionPermissions;
  run?: DockerCommand;
  pollMs?: number;
}): Promise<PlatformExecutor & { resolveImage(reference: string): Promise<string>; cleanup(id: string): Promise<void> }> {
  if (!/^docker:[a-zA-Z0-9_.-]+$/.test(options.engineId)) throw new Error('Select a local Docker engine.');
  const permissions = { ...options.permissions }, run = options.run ?? runDocker;
  const contexts: unknown = JSON.parse(await run(['context', 'inspect', options.engineId.slice(7)]));
  if (!Array.isArray(contexts) || contexts.length !== 1) throw new Error('Invalid Docker context.');
  const host = record(record(record(contexts[0]).Endpoints).docker).Host;
  if (typeof host !== 'string' || !host.startsWith('unix:///')) throw new Error('Only local Docker engines are supported.');
  const prefix = ['--host', host];
  async function inspect(id: string) {
    const name = containerName(id);
    const ids = (await run([...prefix, 'container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).trim();
    if (!ids) return null;
    if (!/^[a-f0-9]{64}$/.test(ids)) throw new Error('Ambiguous platform container.');
    const values: unknown = JSON.parse(await run([...prefix, 'container', 'inspect', ids]));
    if (!Array.isArray(values) || values.length !== 1) throw new Error('Invalid container inspection.');
    const raw = record(values[0]), config = record(raw.Config), labels = record(config.Labels), state = record(raw.State);
    if (raw.Id !== ids || raw.Name !== `/${name}` || labels[label] !== id) throw new Error('Platform container ownership changed.');
    return { id: ids, image: imageId(raw.Image), state };
  }
  return {
    identity: `docker:${host}`,
    async resolveImage(reference) {
      if (!reference || reference.startsWith('-') || /[\s\0]/.test(reference)) throw new Error('Invalid image reference.');
      return imageId((await run([...prefix, 'image', 'inspect', reference, '--format', '{{.Id}}'])).trim());
    },
    async inspect(id) {
      const container = await inspect(id);
      if (!container) return 'missing';
      return ['exited', 'dead'].includes(String(container.state.Status)) ? 'stopped' : 'running';
    },
    async cleanup(id) {
      const container = await inspect(id);
      if (!container) return;
      if (!['exited', 'dead', 'created'].includes(String(container.state.Status))) throw new Error('Stop the platform run before cleanup.');
      await run([...prefix, 'container', 'rm', container.id]);
    },
    async execute(input: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionReceipt> {
      const plan = executionPlan(input), id = identifier(input.id);
      if (permissions.commandExecution !== true || (input.writable !== false && input.writable !== true)
        || (input.writable === true && permissions.fileWrite !== true)) throw new Error('This run exceeds the saved execution permissions.');
      signal?.throwIfAborted();
      const workspace = await realpath(input.workspace);
      if (/[,\r\n]/.test(workspace)) throw new Error('This workspace path cannot be mounted by Docker.');
      const gitLink = join(workspace, '.git');
      if (!(await lstat(gitLink)).isFile()) throw new Error('Docker workers require a linked worktree; shared Git metadata must stay outside the container.');
      if (await inspect(id)) throw new Error('This run already owns a container. Inspect it instead of replaying it.');
      const startedAt = new Date().toISOString();
      const rawId = (await run([...prefix, 'container', 'create', '--name', containerName(id), '--pull', 'never',
        '--label', `${label}=${id}`, '--read-only', '--init', '--network', 'none', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--cpus', String(plan.cpus), '--memory', `${plan.memoryMb}m`, '--pids-limit', '256',
        '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
        '--mount', `type=bind,src=${workspace},dst=/workspace${input.writable ? '' : ',readonly'}`,
        // Protect the link file without mounting the common Git directory it points to.
        '--mount', `type=bind,src=${gitLink},dst=/workspace/.git,readonly`,
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--workdir', '/workspace',
        '--env', 'TMPDIR=/tmp', '--entrypoint', plan.command[0]!, plan.image, ...plan.command.slice(1)])).trim();
      const container = await inspect(id);
      assertCreatedContainer(container, rawId, plan.image);
      await run([...prefix, 'container', 'start', rawId]);
      const deadline = Date.now() + plan.timeoutMs;
      let interrupted = false;
      for (;;) {
        const current = await inspect(id);
        assertCreatedContainer(current, rawId, plan.image);
        if (['exited', 'dead'].includes(String(current!.state.Status))) {
          const exitCode = current!.state.ExitCode;
          if (!Number.isInteger(exitCode) || Number(exitCode) < 0 || Number(exitCode) > 255) throw new Error('Invalid container exit status.');
          const output = redactAgentLogs(await run([...prefix, 'container', 'logs', '--tail', '1000', rawId]));
          return { id, image: plan.image, exitCode: interrupted && exitCode === 0 ? 137 : Number(exitCode),
            output, startedAt, finishedAt: new Date().toISOString() };
        }
        if (signal?.aborted || Date.now() >= deadline) {
          await run([...prefix, 'container', 'kill', rawId]);
          interrupted = true;
        }
        await delay(options.pollMs ?? 100);
      }
    },
  };
}

function assertCreatedContainer(container: { id: string; image: string } | null, id: string, image: string): void {
  if (!/^[a-f0-9]{64}$/.test(id) || !container || container.id !== id || container.image !== image) throw new Error('Container identity changed.');
}
