import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SpecialistAgent } from '../../shared/agent-registry.ts';
import { githubRepositoryName } from '../github-repositories.mts';
import { HomieRepository, type HomieRepositoryOptions } from './homie-repository.mts';
import { homieRepositoryTemplate } from './homie-repository-template.mts';
import { checkedRepositoryCommand, repositoryCommandFailure, runRepositoryCommand } from './homie-repository-command.mts';
import { parseHomieRepository, type HomieRepositoryConnection, type HomieRepositoryPreview } from '../../shared/homie-repository-connection.ts';
import { readHomieSource } from './homie-source-files.mts';
import type { AgentPackage } from '../../shared/agent-package.ts';

interface Account { id: number; login: string }
interface RepositoryPlan { agentId: string; repository: string; directory: string; accountId?: number; existingOnly?: true }
const planning = new Map<string, Promise<unknown>>();
const validAgentId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Account choices and stable Homie mappings live only in this user's application data. */
export class HomieRepositoryProjects {
  private readonly stateDirectory: string;
  private readonly projectsDirectory: string;
  private readonly run: NonNullable<HomieRepositoryOptions['run']>;
  constructor(options: { stateDirectory: string; projectsDirectory?: string; run?: HomieRepositoryOptions['run'] }) {
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.projectsDirectory = path.resolve(options.projectsDirectory ?? path.join(homedir(), 'Developments'));
    this.run = options.run ?? runRepositoryCommand;
  }
  private async account(): Promise<Account> {
    const value = JSON.parse(await checkedRepositoryCommand(this.run, 'gh', ['api', '--hostname', 'github.com', 'user']));
    if (!Number.isSafeInteger(value?.id) || value.id <= 0 || typeof value.login !== 'string') {
      throw new Error('GitHub account could not be verified.');
    }
    githubRepositoryName(`${value.login}/homie`);
    return { id: value.id, login: value.login };
  }
  private async verifyOwner(owner: string, account: Account): Promise<void> {
    githubRepositoryName(`${owner}/homie`);
    if (owner.toLowerCase() === account.login.toLowerCase()) return;
    const membership = JSON.parse(await checkedRepositoryCommand(this.run, 'gh',
      ['api', '--hostname', 'github.com', `user/memberships/orgs/${owner}`]));
    if (membership?.state !== 'active' || membership.organization?.login?.toLowerCase() !== owner.toLowerCase()) {
      throw new Error('Choose your GitHub account or an organization with active membership.');
    }
  }
  private async write(filename: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  /** Explicit local preference, keyed by GitHub account ID rather than shipped defaults. */
  async setOwner(owner: string): Promise<void> {
    const account = await this.account();
    await this.verifyOwner(owner, account);
    await this.write(path.join(this.stateDirectory, 'owners', `${account.id}.json`), { accountId: account.id, owner });
  }
  private async owner(account: Account): Promise<string> {
    let saved;
    try { saved = JSON.parse(await readFile(path.join(this.stateDirectory, 'owners', `${account.id}.json`), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return account.login; throw error; }
    if (saved?.accountId !== account.id || typeof saved.owner !== 'string') throw new Error('Invalid local Homie repository owner setting.');
    await this.verifyOwner(saved.owner, account);
    return saved.owner;
  }
  private parsePlan(value: unknown, agentId: string): RepositoryPlan {
    const plan = value as Partial<RepositoryPlan> | null;
    const repository = plan?.repository;
    if (plan?.agentId !== agentId || typeof repository !== 'string'
      || (plan.existingOnly !== true && !/^[^/]+\/[Hh]omie-[a-z0-9-]+$/.test(repository))
      || (plan.existingOnly !== undefined && plan.existingOnly !== true)
      || (plan.accountId !== undefined && (!Number.isSafeInteger(plan.accountId) || plan.accountId <= 0))
      || plan.directory !== path.join(this.projectsDirectory, repository.split('/')[1]!.toLowerCase())) {
      throw new Error('Inspect the saved Homie repository mapping. Existing files were retained.');
    }
    githubRepositoryName(repository);
    return { agentId, repository, directory: plan.directory, ...(plan.accountId === undefined ? {} : { accountId: plan.accountId }),
      ...(plan.existingOnly === true ? { existingOnly: true } : {}) };
  }
  async local(agentId: string): Promise<RepositoryPlan | null> {
    if (!validAgentId.test(agentId)) throw new Error('Invalid Homie ID.');
    try { return this.parsePlan(JSON.parse(await readFile(path.join(this.stateDirectory, `${agentId}.json`), 'utf8')), agentId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async plan(agent: Pick<SpecialistAgent, 'id' | 'name'>): Promise<RepositoryPlan> {
    if (!validAgentId.test(agent.id)) throw new Error('Invalid Homie ID.');
    const previous = planning.get(this.stateDirectory) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.preparePlan(agent));
    planning.set(this.stateDirectory, operation);
    try { return await operation; }
    finally { if (planning.get(this.stateDirectory) === operation) planning.delete(this.stateDirectory); }
  }
  private async preparePlan(agent: Pick<SpecialistAgent, 'id' | 'name'>): Promise<RepositoryPlan> {
    const account = await this.account();
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.stateDirectory, '.planning-lock');
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Homie repository planning is already running. Retry after inspecting the planning lock.');
      throw error;
    }
    try {
      const filename = path.join(this.stateDirectory, `${agent.id}.json`);
      if (await exists(filename)) {
        const plan = this.parsePlan(JSON.parse(await readFile(filename, 'utf8')), agent.id);
        if (plan.accountId !== undefined && plan.accountId !== account.id) throw new Error('This Homie repository belongs to another GitHub account. Switch to its account before continuing.');
        const owner = plan.repository.split('/')[0]!;
        if (plan.accountId === undefined && owner.toLowerCase() !== (await this.owner(account)).toLowerCase()) {
          throw new Error('Confirm the existing Homie repository owner in your local account settings before continuing.');
        }
        if (!plan.existingOnly) await this.verifyOwner(owner, account);
        if (plan.accountId === undefined) { plan.accountId = account.id; await this.write(filename, plan); }
        return plan;
      }
      const owner = await this.owner(account);
      const reserved = new Set<string>();
      for (const file of await readdir(this.stateDirectory)) {
        const id = file.replace(/\.json$/, '');
        if (!validAgentId.test(id)) continue;
        const saved = this.parsePlan(JSON.parse(await readFile(path.join(this.stateDirectory, file), 'utf8')), id);
        reserved.add(saved.directory.toLowerCase());
      }
      const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'agent';
      const shortId = agent.id.replaceAll('-', '');
      for (const suffix of ['', ...[8, 12, 16, 32].map(length => `-${shortId.slice(0, length)}`)]) {
        const name = `Homie-${slug}${suffix}`, repository = `${owner}/${name}`;
        const directory = path.join(this.projectsDirectory, name.toLowerCase());
        if (reserved.has(directory.toLowerCase()) || await exists(directory)) continue;
        const remote = await this.run('gh', ['api', '--hostname', 'github.com', `repos/${repository}`]);
        if (remote.code === 0) continue;
        if (!/HTTP 404\b/.test(remote.stderr)) throw repositoryCommandFailure(remote);
        const plan = { agentId: agent.id, repository, directory, accountId: account.id };
        await this.write(filename, plan);
        return plan;
      }
      throw new Error('Homie repository names are occupied. Choose another Homie name.');
    } finally { await rmdir(lock); }
  }
  async ensure(agent: SpecialistAgent) {
    const plan = await this.plan(agent);
    return new HomieRepository({ ...plan, requireInitialization: !plan.existingOnly, run: this.run,
      template: () => homieRepositoryTemplate(agent) }).ensure();
  }

  private async assertUnconnected(repository: string, directory: string): Promise<void> {
    let files: string[];
    try { files = await readdir(this.stateDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      if (!validAgentId.test(id)) continue;
      const saved = await this.local(id);
      if (saved && (saved.repository.toLowerCase() === repository.toLowerCase() || saved.directory.toLowerCase() === directory.toLowerCase())) {
        throw new Error('This repository is already connected or reserved for a Homie. Open that Homie instead.');
      }
    }
  }

  async previewExisting(value: string): Promise<HomieRepositoryPreview> {
    const repository = parseHomieRepository(value);
    const directory = path.join(this.projectsDirectory, repository.split('/')[1]!.toLowerCase());
    await this.assertUnconnected(repository, directory);
    const checkout = await new HomieRepository({ repository, directory, existingOnly: true, run: this.run,
      template: async () => { throw new Error('Existing repositories cannot be initialized.'); } }).ensure();
    const source = await readHomieSource(checkout.directory);
    return { repository: checkout.repository, directory: checkout.directory, hash: source.hash, definition: source.pack };
  }

  /** Persist the mapping before synchronous registration; rollback only our mapping if registration fails. */
  async connectExisting<T>(input: HomieRepositoryConnection, save: (id: string, definition: AgentPackage) => T): Promise<T> {
    const previous = planning.get(this.stateDirectory) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      const lock = path.join(this.stateDirectory, '.planning-lock');
      try { await mkdir(lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another Homie is being connected. Try again after it finishes.');
        throw error;
      }
      try {
        const account = await this.account();
        const preview = await this.previewExisting(input.repository);
        assertReviewedSource(preview.hash, input.hash);
        const id = randomUUID(), filename = path.join(this.stateDirectory, `${id}.json`);
        await this.write(filename, { agentId: id, repository: preview.repository, directory: preview.directory, accountId: account.id, existingOnly: true });
        try { return save(id, preview.definition); }
        catch (error) { await unlink(filename); throw error; }
      } finally { await rmdir(lock); }
    });
    planning.set(this.stateDirectory, operation);
    try { return await operation; }
    finally { if (planning.get(this.stateDirectory) === operation) planning.delete(this.stateDirectory); }
  }
}

function assertReviewedSource(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('Repository files changed. Check the repository again before connecting it.');
}
