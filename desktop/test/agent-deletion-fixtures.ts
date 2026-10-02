import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { createDockerDeletion } from '../lib/agent-management/docker-deletion.mts';
import { createAgentDeletion } from '../lib/agent-management/deletion.mts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';
import type { ReadWorker } from '../lib/agent-management/service.mts';
import { specialistInput } from './agent-registry-fixtures';

export function deletionFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-deletion-'));
  const registry = createAgentRegistry(join(directory, 'registry.json'));
  const workspace = '/projects/cheshi';
  const profile = registry.save(specialistInput(), workspace).snapshot.agents[0]!;
  const containerId = 'a'.repeat(64), binding = `${profile.id}-${'b'.repeat(16)}`;
  const volume = `cheshi-agent-${binding}-${'c'.repeat(8)}`;
  const worker = { Id: containerId, Name: '/worker', Config: { Image: 'fixture', Labels: {
    'ai.cheshi.worker': 'specialist-v1', 'ai.cheshi.agent': profile.id, 'ai.cheshi.binding': binding,
  } }, State: { Status: 'running' }, NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '49831' }] } },
  Mounts: [{ Type: 'volume', Name: volume, Destination: '/agent' }, { Type: 'bind', Source: workspace, Destination: '/workspace' }] };
  const containers = new Map([[containerId, worker]]), volumes = new Set([volume]);
  const calls: string[][] = [];
  const state = { busy: false, unknown: false, failVolume: false, failRemove: false, shared: false,
    offline: '', remote: false, nonstandardVolume: false, malformedHealth: false };
  const run: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: state.remote ? 'ssh://remote' : `unix:///tmp/${args[2]}.sock` } } }]);
    if (state.offline && args[1]?.includes(state.offline)) throw new Error('engine offline');
    const [kind, action] = args.slice(2), target = args.at(-1)!;
    if (kind === 'container' && action === 'ls') {
      let found = [...containers.keys()];
      for (const filter of args.filter((_value, index) => args[index - 1] === '--filter')) {
        if (filter.startsWith('id=')) found = found.filter(id => id === filter.slice(3));
        if (filter.startsWith('label=')) {
          const [key, value] = filter.slice(6).split('=');
          found = found.filter(id => (containers.get(id)!.Config.Labels as Record<string, string>)[key!] === value);
        }
        if (filter.startsWith('volume=')) {
          found = found.filter(id => containers.get(id)!.Mounts.some(mount => mount.Name === filter.slice(7)));
          if (state.shared) found.push('d'.repeat(64));
        }
      }
      return found.join('\n');
    }
    if (kind === 'container' && action === 'inspect') {
      if (!containers.has(target)) throw new Error('container missing');
      return JSON.stringify([containers.get(target)]);
    }
    if (kind === 'container' && action === 'stop') { containers.get(target)!.State.Status = 'exited'; return target; }
    if (kind === 'container' && action === 'rm') {
      if (state.failRemove) throw new Error('remove failed');
      containers.delete(target); return target;
    }
    if (kind === 'volume' && action === 'ls') return [...volumes].join('\n');
    if (kind === 'volume' && action === 'inspect') return JSON.stringify([{ Name: target, Driver: 'local', Options: state.nonstandardVolume ? { device: '/private/data' } : null }]);
    if (kind === 'volume' && action === 'rm') {
      if (state.failVolume) throw new Error('volume removal failed');
      volumes.delete(target); return target;
    }
    throw new Error(`Unexpected fixture command: ${kind}/${action}`);
  };
  const read: ReadWorker = async (_endpoint, path) => path === '/health'
    ? { ready: true, busy: state.malformedHealth ? 'false' : state.busy }
    : { tasks: state.unknown ? [{ id: 'task', prompt: 'test', output: '', error: null, createdAt: '2026-10-02', status: 'unknown' }] : [] };
  const engines = [{ id: 'docker:local', name: 'local', supported: true, reason: null }];
  const options = { directory: join(directory, 'deletions'), runtimeDirectory: join(directory, 'runtimes'), registry,
    management: { engines: async () => ({ engines, error: null }) }, docker: createDockerDeletion(run, read) };
  const rememberEngine = (engineId: string, host?: string) => {
    const path = join(options.runtimeDirectory, createHash('sha256').update(engineId).digest('hex'), binding);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'runtime.json'), '{}');
    if (host) writeFileSync(join(path, 'engine.json'), JSON.stringify({ engineId, host }));
    return path;
  };
  const runtimePath = rememberEngine('docker:local');
  return { directory, registry, workspace, profile, worker, containerId, binding, volume, containers, volumes, calls, state, engines,
    options, run, rememberEngine, runtimePath, deletion: createAgentDeletion(options),
    request: (deleteData = false) => ({ engineId: 'docker:local', containerId, deleteData }),
    agentRequest: (deleteData = false) => ({ id: profile.id, revision: profile.revision, deleteData }),
    close: () => rmSync(directory, { recursive: true, force: true }) };
}
