import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentRecord, agentText, parseAgentAction, parseAgentEngineId, parseAgentId } from '../../shared/agent-management.ts';
import type { AgentAction, AgentEngineInfo } from '../../shared/agent-management.ts';
import type { AgentEngine, RuntimeAgent } from './engine.mts';

export type DockerCommand = (args: string[], input?: string) => Promise<string>;
const project = 'cheshi-codex-specialists-test';
const service = 'verifier';
const labels = { project: 'com.docker.compose.project', service: 'com.docker.compose.service' };
function dockerExecutable() { return ['/opt/homebrew/bin/docker', '/usr/local/bin/docker'].find(existsSync) ?? 'docker'; }

export const runDocker: DockerCommand = (args, input) => new Promise((resolve, reject) => {
  const executable = dockerExecutable();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DOCKER_')) delete env[key];
  const child = execFile(executable, ['--config', join(homedir(), '.docker'), ...args], {
    env, timeout: args.includes('build') ? 600_000 : 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
  }, (error, stdout, stderr) => {
    if (error) { reject(new Error('Docker command failed. Check that Docker CLI is installed and the selected engine is running.')); return; }
    // Docker sends container stderr through its own stderr for `logs`.
    resolve(args.includes('logs') ? `${stdout}${stderr}` : stdout);
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

function dockerContext(engineId: string): string {
  const id = parseAgentEngineId(engineId);
  if (!id.startsWith('docker:')) throw new TypeError('Unsupported engine adapter.');
  return id.slice('docker:'.length);
}
function containerId(value: string): string {
  const id = parseAgentId(value);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError('Expected a full Docker container ID.');
  return id;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid Docker response.');
  return value;
}
export function redactAgentLogs(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,})\b/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/((?:access_token|refresh_token|api_key|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .slice(-256_000);
}

/** Adopt labelled specialists and the legacy Compose verifier. Names alone never authorize actions. */
export function parseDockerAgent(value: unknown): RuntimeAgent {
  const raw = agentRecord(value), config = agentRecord(raw.Config), state = agentRecord(raw.State);
  const metadata = agentRecord(config.Labels);
  const specialist = metadata['ai.cheshi.worker'] === 'specialist-v1'
    && typeof metadata['ai.cheshi.agent'] === 'string' && /^[a-f0-9-]{36}$/.test(metadata['ai.cheshi.agent']);
  if ((!specialist && (metadata[labels.project] !== project || metadata[labels.service] !== service))
    || metadata['com.docker.compose.oneoff'] === 'True') throw new Error('This container is not a managed Cheshi worker.');
  const ports = agentRecord(agentRecord(raw.NetworkSettings).Ports);
  const bindings = ports['8787/tcp'];
  let endpoint: string | null = null;
  if (Array.isArray(bindings) && bindings.length === 1) {
    const binding = agentRecord(bindings[0]);
    if (binding.HostIp === '127.0.0.1' && typeof binding.HostPort === 'string'
      && /^\d{1,5}$/.test(binding.HostPort) && Number(binding.HostPort) > 0 && Number(binding.HostPort) <= 65535) {
      endpoint = `http://127.0.0.1:${binding.HostPort}`;
    }
  }
  return { id: containerId(agentText(raw.Id)), name: agentText(raw.Name).replace(/^\//, ''),
    image: agentText(config.Image), state: agentText(state.Status, 100), endpoint };
}

export function createDockerAgentEngine(run: DockerCommand = runDocker): AgentEngine {
  const localHost = async (engineId: string) => {
    const context = dockerContext(engineId);
    const entries = array(JSON.parse(await run(['context', 'inspect', context])));
    const endpoint = agentRecord(agentRecord(agentRecord(entries[0]).Endpoints).docker).Host;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///')) throw new Error('Only local Docker engines are supported.');
    return endpoint;
  };
  const ensureLocal = async (engineId: string) => { await localHost(engineId); return ['--context', dockerContext(engineId)]; };
  const inspect = async (engineId: string, agentId: string): Promise<RuntimeAgent> => {
    const id = containerId(agentId);
    const prefix = await ensureLocal(engineId);
    const values = array(JSON.parse(await run([...prefix, 'container', 'inspect', id])));
    const agent = parseDockerAgent(values[0]);
    if (agent.id !== id) throw new Error('Container identity changed. Refresh the worker list.');
    return agent;
  };
  return {
    kind: 'docker',
    async engines() {
      const output = await run(['context', 'ls', '--format', '{{json .}}']);
      return output.split(/\r?\n/).filter(Boolean).map(line => {
        const raw = agentRecord(JSON.parse(line));
        const name = agentText(raw.Name, 180), host = agentText(raw.DockerEndpoint);
        const supported = host.startsWith('unix:///');
        return { id: parseAgentEngineId(`docker:${name}`), name, supported,
          reason: supported ? null : 'Only local Docker engines are supported.' } satisfies AgentEngineInfo;
      });
    },
    async list(engineId) {
      const prefix = await ensureLocal(engineId);
      const output = await run([...prefix, 'container', 'ls', '--all', '--no-trunc', '--filter', `label=${labels.project}=${project}`,
        '--filter', `label=${labels.service}=${service}`, '--format', '{{json .}}']);
      const specialists = await run([...prefix, 'container', 'ls', '--all', '--no-trunc', '--filter', 'label=ai.cheshi.worker=specialist-v1', '--format', '{{json .}}']);
      const ids = `${output}\n${specialists}`.split(/\r?\n/).filter(Boolean).map(line => containerId(agentText(agentRecord(JSON.parse(line)).ID)));
      // Inspect again so filters and display names cannot stand in for ownership verification.
      const agents: RuntimeAgent[] = [];
      for (const id of new Set(ids)) {
        const values = array(JSON.parse(await run([...prefix, 'container', 'inspect', id])));
        const raw = agentRecord(values[0]);
        const metadata = agentRecord(agentRecord(raw.Config).Labels);
        if (metadata['com.docker.compose.oneoff'] === 'True') continue;
        agents.push(parseDockerAgent(raw));
      }
      return agents.map(({ endpoint: _endpoint, ...agent }) => agent);
    },
    inspect,
    async terminalCommand(engineId, agentId) {
      const host = await localHost(engineId), id = containerId(agentId);
      // Pin both verification and exec to the resolved socket, even if the context changes later.
      const values = array(JSON.parse(await run(['--host', host, 'container', 'inspect', id])));
      const agent = parseDockerAgent(values[0]);
      if (agent.id !== id || agent.state !== 'running') throw new Error('Start the selected container before opening its terminal.');
      const executable = dockerExecutable();
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const unset = Object.keys(process.env).filter(key => key.startsWith('DOCKER_')).flatMap(key => ['-u', key]);
      return ['/usr/bin/env', ...unset, executable, '--config', join(homedir(), '.docker'), '--host', host,
        'exec', '--interactive', '--tty', '--env', 'TERM=xterm-256color', id, '/bin/sh'].map(quote).join(' ');
    },
    async control(engineId, agentId, input: AgentAction) {
      const action = parseAgentAction(input);
      const agent = await inspect(engineId, agentId);
      if (action === 'start' ? !['created', 'exited'].includes(agent.state) : agent.state !== 'running') {
        throw new Error('Worker state changed. Refresh before trying again.');
      }
      const prefix = await ensureLocal(engineId);
      await run([...prefix, 'container', action, ...(action === 'start' ? [] : ['--time', '15']), agent.id]);
    },
    async logs(engineId, agentId) {
      const agent = await inspect(engineId, agentId);
      const prefix = await ensureLocal(engineId);
      return redactAgentLogs(await run([...prefix, 'container', 'logs', '--tail', '200', '--timestamps', agent.id]));
    },
  };
}
