import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentRecord, agentText, parseAgentId, parseDeleteContainer } from '../../shared/agent-management.ts';
import type { AgentManagementApi } from '../../shared/agent-management.ts';
import { parseDeleteSpecialistAgent } from '../../shared/agent-registry.ts';
import type { createAgentRegistry } from './registry.mts';
import { createDockerDeletion, validWorkerVolume, type DockerDeletionPlan } from './docker-deletion.mts';
import { workerOperations } from './operations.mts';

interface Journal { key: string; deleteData: boolean; plans: DockerDeletionPlan[] }
function mergePlan(journal: Journal, plan: DockerDeletionPlan) {
  const previous = journal.plans.find(item => item.host === plan.host);
  if (previous) {
    previous.containers = [...new Set([...previous.containers, ...plan.containers])];
    previous.volumes = [...new Set([...previous.volumes, ...plan.volumes])];
  } else journal.plans.push(plan);
}
export function createAgentDeletion(options: {
  directory: string; runtimeDirectory: string; registry: ReturnType<typeof createAgentRegistry>;
  management: Pick<AgentManagementApi, 'engines'>; docker?: ReturnType<typeof createDockerDeletion>;
}) {
  const docker = options.docker ?? createDockerDeletion();
  const filename = (key: string) => join(options.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  async function load(key: string, deleteData: boolean): Promise<Journal | null> {
    let text: string;
    try { text = await readFile(filename(key), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value = agentRecord(JSON.parse(text));
    if (value.key !== key || value.deleteData !== deleteData || !Array.isArray(value.plans)) {
      throw new Error('Retry this deletion with the same saved-data option.');
    }
    const plans = value.plans.map(raw => {
      const plan = agentRecord(raw);
      if (!Array.isArray(plan.containers) || !plan.containers.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
        || !Array.isArray(plan.volumes) || !plan.volumes.every(name => typeof name === 'string' && validWorkerVolume(name))
        || typeof plan.host !== 'string' || !plan.host.startsWith('unix:///') || (!deleteData && plan.volumes.length)) {
        throw new Error('Invalid saved deletion targets.');
      }
      return { engineId: agentText(plan.engineId), host: plan.host, containers: plan.containers as string[], volumes: plan.volumes as string[],
        ...(plan.profileId === undefined ? {} : { profileId: parseAgentId(plan.profileId) }) };
    });
    return { key, deleteData, plans };
  }
  async function execute(journal: Journal, profileId?: string) {
    for (const plan of journal.plans) await docker.preflight(plan, profileId);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const target = filename(journal.key);
    await writeFile(`${target}.tmp`, JSON.stringify(journal), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
    for (const plan of journal.plans) await docker.execute(plan, profileId);
  }
  async function finish(key: string) {
    // A leftover journal is harmless; an acknowledged deletion must not become a false failure.
    try { await rm(filename(key), { force: true }); }
    catch { console.error('[cheshi] Could not remove a completed worker deletion record.'); }
  }
  async function journals() {
    let entries: string[];
    try { entries = await readdir(options.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const values: Record<string, unknown>[] = [];
    for (const entry of entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      let text: string;
      try { text = await readFile(join(options.directory, entry), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      values.push(agentRecord(JSON.parse(text)));
    }
    return values;
  }
  async function usedEngines(id: string, catalog: { id: string }[]) {
    const used = new Map<string, string | null>();
    let engines;
    try { engines = await readdir(options.runtimeDirectory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return used; throw error; }
    for (const engine of engines) {
      if (!engine.isDirectory() || !/^[a-f0-9]{64}$/.test(engine.name)) continue;
      const parent = join(options.runtimeDirectory, engine.name);
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !new RegExp(`^${id}-[a-f0-9]{16}$`).test(entry.name)) continue;
        let record: Record<string, unknown> | null = null;
        try { record = agentRecord(JSON.parse(await readFile(join(parent, entry.name, 'engine.json'), 'utf8'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        // Older workers have only runtime.json under the SHA-256 engine directory.
        const engineId = record ? agentText(record.engineId)
          : catalog.find(item => createHash('sha256').update(item.id).digest('hex') === engine.name)?.id;
        if (!engineId || !engineId.startsWith('docker:')
          || createHash('sha256').update(engineId).digest('hex') !== engine.name) {
          throw new Error('Cannot identify a previously used worker engine. Restore its Docker context before deleting this agent.');
        }
        const host = record ? agentText(record.host) : null;
        if (host !== null && !host.startsWith('unix:///')) throw new Error(`Invalid saved worker engine: ${engineId}.`);
        const previous = used.get(engineId);
        if (previous && host && previous !== host) throw new Error(`Conflicting worker engine history: ${engineId}.`);
        used.set(engineId, host ?? previous ?? null);
      }
    }
    return used;
  }
  async function removeRuntimeConfiguration(id: string) {
    let engines;
    try { engines = await readdir(options.runtimeDirectory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const engine of engines) {
      if (!engine.isDirectory() || !/^[a-f0-9]{64}$/.test(engine.name)) continue;
      const parent = join(options.runtimeDirectory, engine.name);
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !new RegExp(`^${id}-[a-f0-9]{16}$`).test(entry.name)) continue;
        const path = join(parent, entry.name);
        await rm(join(path, 'runtime.json'), { force: true });
        await rm(join(path, 'runtime.json.tmp'), { force: true });
        await rm(join(path, 'engine.json'), { force: true });
        await rm(join(path, 'engine.json.tmp'), { force: true });
        await rmdir(path);
      }
    }
  }
  return {
    async pending(engineId: string) {
      const pending = [];
      for (const value of await journals()) {
        const prefix = `container:${engineId}/`;
        if (typeof value.key !== 'string' || !value.key.startsWith(prefix)) continue;
        const request = parseDeleteContainer({ engineId, containerId: value.key.slice(prefix.length), deleteData: value.deleteData });
        if (await load(value.key, request.deleteData)) pending.push(request);
      }
      return pending;
    },
    async container(value: unknown) {
      const input = parseDeleteContainer(value);
      return workerOperations.exclusive(async () => {
        const key = `container:${input.engineId}/${input.containerId}`;
        const journal = await load(key, input.deleteData) ?? { key, deleteData: input.deleteData,
          plans: [await docker.plan(input.engineId, input.deleteData, undefined, input.containerId)] };
        await execute(journal);
        await finish(key);
      });
    },
    async agent(workspaceRoot: string, value: unknown) {
      const input = parseDeleteSpecialistAgent(value);
      return workerOperations.exclusive(async () => {
        const assertCurrent = () => {
          const agent = options.registry.snapshot(workspaceRoot).agents.find(item => item.id === input.id);
          if (!agent || agent.revision !== input.revision) throw new Error('This agent changed. Reopen its settings before deleting.');
        };
        assertCurrent();
        const key = `agent:${input.id}`, journal = await load(key, input.deleteData) ?? { key, deleteData: input.deleteData, plans: [] };
        const related: Journal[] = [];
        for (const value of await journals()) {
          if (typeof value.key !== 'string' || !value.key.startsWith('container:') || typeof value.deleteData !== 'boolean') continue;
          const previous = await load(value.key, value.deleteData);
          if (previous?.plans.length && previous.plans.every(plan => plan.profileId === input.id)) {
            related.push(previous);
            for (const plan of previous.plans) mergePlan(journal, { ...plan, volumes: input.deleteData ? plan.volumes : [] });
          }
        }
        const catalog = await options.management.engines();
        const engines = await usedEngines(input.id, catalog.engines);
        for (const plan of journal.plans) {
          const host = engines.get(plan.engineId);
          if (host && host !== plan.host) throw new Error(`Worker engine history changed: ${plan.engineId}.`);
          engines.set(plan.engineId, plan.host);
        }
        for (const [engineId, host] of engines) {
          let plan: DockerDeletionPlan;
          try { plan = await docker.plan(engineId, input.deleteData, input.id); }
          catch { throw new Error(`Cannot inspect previously used worker engine ${engineId}. Restore its connection before deleting this agent.`); }
          if (host && plan.host !== host) throw new Error(`Worker engine ${engineId} changed. Restore its original connection before deleting this agent.`);
          mergePlan(journal, plan);
        }
        assertCurrent();
        await execute(journal, input.id);
        await removeRuntimeConfiguration(input.id);
        // The confirmed global deletion supersedes earlier per-container cleanup choices for this profile.
        for (const previous of related) await finish(previous.key);
        const result = options.registry.remove(input, workspaceRoot);
        await finish(key);
        return result;
      });
    },
  };
}
