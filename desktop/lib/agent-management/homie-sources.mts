import { mkdir, readFile, writeFile, rename, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertFileManagedInstructions, readProjectInstructions } from './instruction-files.mts';
import { portableAgent, readHomieSource, readSourceFile, sourceDigest, sourceFiles } from './homie-source-files.mts';
import type { createAgentRegistry } from './registry.mts';
import type { HomieRepositoryProjects } from './homie-repository-project.mts';
import type { HomieSourceState } from '../../shared/homie-source.ts';
import type { AgentPackage } from '../../shared/agent-package.ts';
import type { SaveSpecialistAgent } from '../../shared/agent-registry.ts';
import { sameAgentModelSelection } from '../../shared/agent-models.ts';

interface SourceRecord { packageId: string; accepted: boolean; backup: string; applied: Record<string, string> }
function assertSourceRecord(value: unknown): asserts value is SourceRecord {
  const record = value as Partial<SourceRecord> | null;
  if (!record || typeof record.packageId !== 'string' || typeof record.accepted !== 'boolean' || typeof record.backup !== 'string'
    || !record.applied || typeof record.applied !== 'object' || Array.isArray(record.applied)
    || Object.values(record.applied).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid Homie source migration record.');
}
interface Options {
  directory: string;
  repositories: Pick<HomieRepositoryProjects, 'local'>;
  registry: ReturnType<typeof createAgentRegistry>;
}
function assertUnchangedModelFile(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('agent.json changed while saving. Reload and retry.');
}
/** Repository files are authoritative; registry data is a validated execution cache. */
export class HomieSources {
  private readonly options: Options;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(options: Options) { this.options = options; }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(id) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(action);
    this.pending.set(id, operation);
    try { return await operation; } finally { if (this.pending.get(id) === operation) this.pending.delete(id); }
  }
  private agent(workspace: string, id: string) {
    const agent = this.options.registry.snapshot(workspace).agents.find(a => a.id === id);
    if (!agent) throw new Error('Homie is no longer registered.');
    return agent;
  }
  private async record(id: string): Promise<SourceRecord | null> {
    try {
      const value = JSON.parse(await readFile(path.join(this.options.directory, `${id}.json`), 'utf8'));
      assertSourceRecord(value);
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async save(id: string, value: SourceRecord): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.options.directory, `${id}.json`), temp = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, filename);
  }
  private async load(workspace: string, id: string, accept = false) {
    const agent = this.agent(workspace, id), mapping = await this.options.repositories.local(id);
    assertFileManagedInstructions(agent, agent.assignments.find(a => a.workspaceRoot === workspace));
    if (!mapping) throw new Error('Homie repository is not connected. Start the Homie to prepare it.');
    const directory = await realpath(mapping.directory);
    if (directory !== mapping.directory) throw new Error('Homie repository path changed. Reconnect the original folder.');
    const source = await readHomieSource(directory);
    let record = await this.record(id);
    if (!record) {
      const original = portableAgent(agent);
      const backup = path.join(this.options.directory, 'backups', `${id}-${randomUUID()}`);
      await mkdir(backup, { recursive: true, mode: 0o700 });
      await writeFile(path.join(backup, 'saved-settings.json'), JSON.stringify(agent, null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(backup, 'repository.json'), JSON.stringify({ pack: source.pack,
        manifest: await readSourceFile(directory, 'agent.json') }, null, 2), { flag: 'wx', mode: 0o600 });
      record = { packageId: original.id, accepted: sourceDigest(original) === source.hash, backup, applied: {} };
      await this.save(id, record);
    }
    if (source.pack.id !== record.packageId) throw new Error('agent.json: package ID must stay unchanged.');
    if (!record.accepted && !accept) return { source, directory, record, agent };
    if (source.legacy) {
      // Materialize legacy inline files without overwriting independently edited files.
      const files = sourceFiles(source.pack), original = await readSourceFile(directory, 'agent.json');
      for (const [name, content] of Object.entries(files)) {
        if (name === 'agent.json' || name === 'instructions.md') continue;
        const target = path.join(directory, name);
        await mkdir(path.dirname(target), { recursive: true });
        try { await writeFile(target, content, { flag: 'wx' }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (await readSourceFile(directory, name) !== content) throw new Error(`${name}: changed during migration. Existing files were preserved.`);
        }
      }
      if (await readSourceFile(directory, 'agent.json') !== original) throw new Error('agent.json changed during migration. Retry.');
      const temporary = path.join(directory, `.agent-${randomUUID()}.tmp`);
      await writeFile(temporary, files['agent.json']!, { flag: 'wx' });
      await rename(temporary, path.join(directory, 'agent.json'));
    }
    if (!record.accepted) { record.accepted = true; await this.save(id, record); }
    const project = await readProjectInstructions(workspace);
    const hash = project === null ? source.hash : createHash('sha256').update(JSON.stringify([source.hash, project])).digest('hex');
    return { source: { ...source, hash }, directory, record, agent };
  }
  status(workspace: string, id: string, engineId = '', accept = false): Promise<HomieSourceState> {
    return this.serial(id, async () => {
      let directory: string | null = null;
      try {
        directory = (await this.options.repositories.local(id))?.directory ?? null;
        if (!directory) return { directory, phase: 'missing', message: 'Start the Homie to prepare its repository.', hash: null };
        const { source, record } = await this.load(workspace, id, accept);
        if (!record.accepted) return { directory, phase: 'conflict', hash: source.hash,
          message: `Repository files differ from saved settings. Both versions were backed up to ${record.backup}. Review them before choosing Use repository files.` };
        const applied = record.applied[JSON.stringify([workspace, engineId])] === source.hash;
        return { directory, phase: applied ? 'applied' : 'pending', hash: source.hash,
          message: applied ? 'Repository configuration is applied.' : 'Changes pending. Apply changes or start the worker. Active work will not be interrupted.' };
      } catch (error) {
        return { directory, phase: 'invalid', hash: null, message: error instanceof Error ? error.message : 'Cannot read Homie files.' };
      }
    });
  }
  prepare(workspace: string, id: string): Promise<{ hash: string; pack: AgentPackage }> {
    return this.serial(id, async () => {
      const { source, record, agent } = await this.load(workspace, id);
      if (!record.accepted) throw new Error('Homie repository conflicts with saved settings. Resolve it in Homie settings first.');
      this.options.registry.applySource(id, agent.revision, source.pack);
      return { hash: source.hash, pack: source.pack };
    });
  }
  saveSettings(workspace: string, input: SaveSpecialistAgent, assertAvailable: () => void = () => {}) {
    const id = input.id;
    if (!id) throw new Error('Create the Homie before editing repository settings.');
    return this.serial(id, async () => {
      const previous = this.agent(workspace, id);
      if (input.revision !== previous.revision) throw new Error('Homie settings changed. Reload and retry.');
      assertAvailable();
      if (sameAgentModelSelection(previous, input.profile)) return this.options.registry.save(input, workspace);
      const { directory, record } = await this.load(workspace, id);
      if (!record.accepted) throw new Error('Homie repository conflicts with saved settings. Resolve it in Homie settings first.');
      const original = await readSourceFile(directory, 'agent.json');
      const source = await readHomieSource(directory);
      if (source.pack.id !== record.packageId) throw new Error('agent.json: package ID must stay unchanged.');
      if (!sameAgentModelSelection(source.pack.model, previous)) throw new Error('Model settings changed in agent.json. Apply repository changes before saving.');
      const selection = { model: input.profile.model, reasoningEffort: input.profile.reasoningEffort, serviceTier: input.profile.serviceTier };
      const manifest = JSON.parse(original);
      const updated = JSON.stringify({ ...manifest, model: selection }, null, 2) + '\n';
      const temporary = path.join(directory, `.agent-${randomUUID()}.tmp`);
      let replaced = false;
      try {
        await writeFile(temporary, updated, { flag: 'wx' });
        assertUnchangedModelFile(await readSourceFile(directory, 'agent.json'), original);
        assertAvailable();
        await rename(temporary, path.join(directory, 'agent.json'));
        replaced = true;
        assertAvailable();
        return this.options.registry.save({ ...input, profile: { ...input.profile,
          package: { ...(previous.package ?? portableAgent(previous)), model: selection } } }, workspace);
      } catch (error) {
        if (replaced && await readSourceFile(directory, 'agent.json') === updated) {
          await writeFile(temporary, original, { flag: 'wx' });
          assertUnchangedModelFile(await readSourceFile(directory, 'agent.json'), updated);
          await rename(temporary, path.join(directory, 'agent.json'));
        }
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
  applied(workspace: string, id: string, engineId: string, hash: string): Promise<void> {
    return this.serial(id, async () => {
      const record = await this.record(id);
      if (!record?.accepted) throw new Error('Homie source was not prepared.');
      record.applied[JSON.stringify([workspace, engineId])] = hash;
      await this.save(id, record);
    });
  }
}
