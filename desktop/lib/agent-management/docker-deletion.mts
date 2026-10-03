import { agentBoolean, agentRecord, agentText, parseAgentTasks } from '../../shared/agent-management.ts';
import { parseDockerAgent, runDocker, type DockerCommand } from './docker.mts';
import { readWorker, type ReadWorker } from './service.mts';

export interface DockerDeletionPlan { engineId: string; host: string; containers: string[]; volumes: string[]; profileId?: string }
const specialistVolume = /^cheshi-agent-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-[a-f0-9]{16}-[a-f0-9]{8}$/;
const legacyVolume = 'cheshi-codex-specialists-test_verifier-space';
function records(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Invalid Docker inspection.');
  return parsed;
}
function lines(value: string) { return value.trim().split(/\s+/).filter(Boolean); }
function pendingWork(activity: Record<string, unknown>): boolean {
  if (activity.collaboration === undefined) return false;
  const state = agentRecord(activity.collaboration);
  if (!Array.isArray(state.incoming) || !Array.isArray(state.outgoing) || !Array.isArray(state.acknowledged) || !Array.isArray(activity.tasks)) {
    throw new Error('Cannot verify pending delegated work.');
  }
  const acknowledged = state.acknowledged, tasks = activity.tasks;
  return state.outgoing.some(raw => { const m = agentRecord(raw); return m.kind === 'work_result' && !acknowledged.includes(m.id); })
    || state.incoming.some(raw => { const m = agentRecord(raw); return m.kind === 'work_request' && !tasks.some(rawTask => agentRecord(rawTask).delegation === m.id); });
}
export function validWorkerVolume(name: string, profileId?: string) {
  return profileId ? specialistVolume.exec(name)?.[1] === profileId : specialistVolume.test(name) || name === legacyVolume;
}

/** Exact IDs, pinned local sockets and owned /agent volumes only. Never removes bind mounts or images. */
export function createDockerDeletion(run: DockerCommand = runDocker, read: ReadWorker = readWorker) {
  const prefix = (plan: DockerDeletionPlan) => ['--host', plan.host];
  async function host(engineId: string) {
    if (!engineId.startsWith('docker:')) throw new Error('Only local Docker workers can be deleted.');
    const values = records(await run(['context', 'inspect', engineId.slice(7)]));
    const endpoint = agentRecord(agentRecord(agentRecord(values[0]).Endpoints).docker).Host;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///')) throw new Error('Only local Docker workers can be deleted.');
    return endpoint;
  }
  async function ids(plan: DockerDeletionPlan, filters: string[] = []) {
    return lines(await run([...prefix(plan), 'container', 'ls', '--all', '--no-trunc', ...filters, '--format', '{{.ID}}']));
  }
  async function inspect(plan: DockerDeletionPlan, id: string, profileId?: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid deletion target.');
    const raw = agentRecord(records(await run([...prefix(plan), 'container', 'inspect', id]))[0]);
    const worker = parseDockerAgent(raw);
    if (worker.id !== id || (profileId && worker.profileId !== profileId)) throw new Error('Worker ownership changed. Refresh before deleting.');
    return { raw, worker };
  }
  async function idle(plan: DockerDeletionPlan, id: string, profileId?: string) {
    const { worker } = await inspect(plan, id, profileId);
    if (worker.state === 'running') {
      if (!worker.endpoint) throw new Error('Cannot verify worker activity. Stop the worker before deleting.');
      const health = agentRecord(await read(worker.endpoint, '/health'));
      const activity = agentRecord(await read(worker.endpoint, '/activity'));
      const tasks = parseAgentTasks(activity.tasks);
      if (!agentBoolean(health.ready) || agentBoolean(health.busy)
        || tasks.some(task => ['accepted', 'running', 'waiting', 'unknown'].includes(task.status)) || pendingWork(activity)) {
        throw new Error('The worker has an active or unconfirmed task. Resolve it before deleting.');
      }
    } else if (!['created', 'exited', 'dead'].includes(worker.state)) throw new Error('The worker is changing state. Stop it before deleting.');
    return worker;
  }
  async function existingVolumes(plan: DockerDeletionPlan) {
    return new Set(lines(await run([...prefix(plan), 'volume', 'ls', '--format', '{{.Name}}'])));
  }
  async function checkVolume(plan: DockerDeletionPlan, name: string, allowedContainers: Set<string>, profileId?: string) {
    if (!validWorkerVolume(name, profileId)) throw new Error('Refusing to delete an unrecognized worker volume.');
    const volume = agentRecord(records(await run([...prefix(plan), 'volume', 'inspect', name]))[0]);
    if (volume.Name !== name || volume.Driver !== 'local' || (volume.Options && Object.keys(agentRecord(volume.Options)).length)) {
      throw new Error('Refusing to delete a nonstandard worker volume.');
    }
    const users = await ids(plan, ['--filter', `volume=${name}`]);
    if (users.some(id => !allowedContainers.has(id))) throw new Error('Saved data is shared with another container. It has not been deleted.');
  }
  return {
    async plan(engineId: string, deleteData: boolean, profileId?: string, containerId?: string): Promise<DockerDeletionPlan> {
      const plan: DockerDeletionPlan = { engineId, host: await host(engineId), containers: [], volumes: [], profileId };
      const found = await ids(plan, containerId ? ['--filter', `id=${containerId}`]
        : ['--filter', 'label=ai.cheshi.worker=specialist-v1', '--filter', `label=ai.cheshi.agent=${profileId}`]);
      if (containerId && !found.includes(containerId)) throw new Error('This container no longer exists. Refresh the list.');
      for (const id of found) {
        if (containerId && id !== containerId) throw new Error('Container identity changed.');
        const { raw, worker } = await inspect(plan, id, profileId);
        if (containerId) plan.profileId = worker.profileId;
        plan.containers.push(id);
        if (deleteData) {
          if (!Array.isArray(raw.Mounts)) throw new Error('Cannot verify the worker storage mounts.');
          for (const value of raw.Mounts) {
            const mount = agentRecord(value);
            if (mount.Destination !== '/agent' || mount.Type !== 'volume') continue;
            const name = agentText(mount.Name);
            const labels = agentRecord(agentRecord(raw.Config).Labels);
            const binding = labels['ai.cheshi.binding'];
            if (!validWorkerVolume(name, worker.profileId)
              || (worker.profileId && (typeof binding !== 'string' || !name.startsWith(`cheshi-agent-${binding}-`)))
              || (!worker.profileId && name !== legacyVolume)) throw new Error('Worker volume ownership could not be verified.');
            plan.volumes.push(name);
          }
        }
      }
      // Also include detached account/project volumes left by earlier worker replacements or deletions.
      if (deleteData && profileId) for (const name of await existingVolumes(plan)) {
        if (validWorkerVolume(name, profileId)) plan.volumes.push(name);
      }
      plan.volumes = [...new Set(plan.volumes)];
      return plan;
    },
    async preflight(plan: DockerDeletionPlan, profileId?: string) {
      if (await host(plan.engineId) !== plan.host) throw new Error('The execution engine changed. Restore it before retrying deletion.');
      const present = new Set(await ids(plan));
      for (const id of plan.containers) if (present.has(id)) await idle(plan, id, profileId);
      const volumes = await existingVolumes(plan);
      for (const name of plan.volumes) if (volumes.has(name)) await checkVolume(plan, name, new Set(plan.containers), profileId);
    },
    async execute(plan: DockerDeletionPlan, profileId?: string) {
      for (const id of plan.containers) {
        if (!(await ids(plan)).includes(id)) continue;
        const worker = await idle(plan, id, profileId);
        if (worker.state === 'running') await run([...prefix(plan), 'container', 'stop', '--time', '15', id]);
        const stopped = await inspect(plan, id, profileId);
        if (!['created', 'exited', 'dead'].includes(stopped.worker.state)) throw new Error('Worker did not stop. Retry deletion after it stops.');
        await run([...prefix(plan), 'container', 'rm', id]);
        if ((await ids(plan)).includes(id)) throw new Error('Container removal could not be confirmed.');
      }
      for (const name of plan.volumes) {
        if (!(await existingVolumes(plan)).has(name)) continue;
        await checkVolume(plan, name, new Set(), profileId);
        await run([...prefix(plan), 'volume', 'rm', name]);
        if ((await existingVolumes(plan)).has(name)) throw new Error('Saved data removal could not be confirmed.');
      }
    },
  };
}
