import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SpecialistAgent } from '../../shared/agent-registry.ts';
import { githubRepositoryName } from '../github-repositories.mts';
import { HomieRepository, type HomieRepositoryOptions } from './homie-repository.mts';
import { homieRepositoryTemplate } from './homie-repository-template.mts';
import { checkedRepositoryCommand, repositoryCommandFailure, runRepositoryCommand } from './homie-repository-command.mts';

interface Account { id: number; login: string }
interface RepositoryPlan { agentId: string; repository: string; directory: string; accountId?: number }
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
      || !/^[^/]+\/[Hh]omie-[a-z0-9-]+$/.test(repository)
      || (plan.accountId !== undefined && (!Number.isSafeInteger(plan.accountId) || plan.accountId <= 0))
      || plan.directory !== path.join(this.projectsDirectory, repository.split('/')[1]!.toLowerCase())) {
      throw new Error('Inspect the saved Homie repository mapping. Existing files were retained.');
    }
    githubRepositoryName(repository);
    return { agentId, repository, directory: plan.directory, ...(plan.accountId === undefined ? {} : { accountId: plan.accountId }) };
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
        await this.verifyOwner(owner, account);
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
    return new HomieRepository({ ...plan, requireInitialization: true, run: this.run,
      template: () => homieRepositoryTemplate(agent) }).ensure();
  }
}
