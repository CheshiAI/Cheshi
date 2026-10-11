import { mkdir, lstat, realpath, readFile, writeFile, rename, unlink, rmdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { githubRepositoryName } from '../github-repositories.mts';
import { checkedRepositoryCommand, repositoryCommandFailure, runRepositoryCommand, type RepositoryCommand } from './homie-repository-command.mts';

interface RemoteRepository { id: number; fullName: string; private: true }
export interface HomieRepositoryOptions {
  repository: string;
  directory?: string;
  run?: RepositoryCommand;
  template: () => Promise<Record<string, string>>;
  requireInitialization?: boolean;
}
export interface HomieRepositoryResult { repository: string; directory: string; created: boolean }
const preparations = new Map<string, Promise<HomieRepositoryResult>>();

export function defaultHomieRepositoryDirectory(repository: string, home = homedir()): string {
  return path.join(home, 'Developments', githubRepositoryName(repository).split('/')[1]!);
}

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function remoteRepository(output: string, repository: string): RemoteRepository {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object' || !('id' in value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0
    || !('full_name' in value) || typeof value.full_name !== 'string' || value.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('GitHub returned an unexpected Homie repository.');
  }
  if (!('private' in value) || value.private !== true) throw new Error('The Homie repository must be private. Its visibility was not changed.');
  return { id: Number(value.id), fullName: value.full_name, private: true };
}

function assertTemplateFiles(files: Record<string, string>): void {
  if (!Object.keys(files).length) throw new Error('The Homie repository template is empty.');
  for (const [name, text] of Object.entries(files)) {
    if (typeof text !== 'string' || name.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')
      || path.isAbsolute(name) || /[\\\0:]/.test(name)) throw new Error('Invalid Homie template path or content.');
  }
}

/** Shared by new-Homie creation and the standalone script; importing this module has no side effects. */
export class HomieRepository {
  readonly repository: string;
  readonly directory: string;
  private readonly run: RepositoryCommand;
  private readonly template: () => Promise<Record<string, string>>;
  private readonly requireInitialization: boolean;

  constructor(options: HomieRepositoryOptions) {
    this.repository = githubRepositoryName(options.repository);
    if (options.directory !== undefined && (!path.isAbsolute(options.directory) || options.directory.includes('\0'))) {
      throw new Error('Choose an absolute project folder for the Homie repository.');
    }
    this.directory = path.resolve(options.directory ?? defaultHomieRepositoryDirectory(this.repository));
    if (this.directory === path.parse(this.directory).root) throw new Error('Choose a project folder for the Homie repository.');
    this.run = options.run ?? runRepositoryCommand;
    this.template = options.template;
    this.requireInitialization = options.requireInitialization === true;
  }

  ensure(): Promise<HomieRepositoryResult> {
    const key = `${this.repository.toLowerCase()}\n${this.directory}`;
    const pending = preparations.get(key);
    if (pending) return pending;
    const operation = this.prepare().finally(() => { if (preparations.get(key) === operation) preparations.delete(key); });
    preparations.set(key, operation);
    return operation;
  }

  private command(command: 'git' | 'gh', args: string[], cwd?: string) {
    return checkedRepositoryCommand(this.run, command, args, cwd);
  }

  private async lookup(): Promise<RemoteRepository | null> {
    const result = await this.run('gh', ['api', '--hostname', 'github.com', `repos/${this.repository}`]);
    if (result.code === 0) return remoteRepository(result.stdout, this.repository);
    // A failed login or connection is not absence. A masked private-repo 404 can
    // only lead to a create request; GitHub still rejects any existing name.
    if (/HTTP 404\b/.test(result.stderr)) return null;
    throw repositoryCommandFailure(result);
  }

  private async create(): Promise<RemoteRepository> {
    const [owner, name] = this.repository.split('/');
    const account: unknown = JSON.parse(await this.command('gh', ['api', '--hostname', 'github.com', 'user']));
    if (!account || typeof account !== 'object' || !('login' in account) || typeof account.login !== 'string') {
      throw new Error('GitHub account could not be verified.');
    }
    const endpoint = account.login.toLowerCase() === owner!.toLowerCase() ? 'user/repos' : `orgs/${owner}/repos`;
    const result = await this.run('gh', ['api', '--hostname', 'github.com', '--method', 'POST', endpoint,
      '-f', `name=${name}`, '-F', 'private=true', '-F', 'auto_init=false', '-f', 'description=Dedicated Cheshi Homie repository']);
    if (result.code !== 0) {
      // Another process may have created it after our read. Reuse only a
      // verified private repository; never turn other errors into creation.
      if (!this.requireInitialization && /HTTP 422\b/.test(result.stderr)) {
        const concurrent = await this.lookup();
        if (concurrent) return concurrent;
      }
      throw repositoryCommandFailure(result);
    }
    return remoteRepository(result.stdout, this.repository);
  }

  private get url() { return `https://github.com/${this.repository}.git`; }

  private async inspectLocal(): Promise<boolean> {
    if (!await exists(this.directory)) return false;
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Homie project path is already occupied. Existing files were retained.');
    const top = await this.command('git', ['rev-parse', '--show-toplevel'], this.directory);
    if (await realpath(top) !== await realpath(this.directory)) throw new Error('The Homie project must be a separate Git checkout.');
    const origin = await this.command('git', ['remote', 'get-url', 'origin'], this.directory);
    const expected = this.repository.toLowerCase();
    if (![this.url.toLowerCase(), `git@github.com:${expected}.git`, `ssh://git@github.com/${expected}.git`].includes(origin.toLowerCase())) {
      throw new Error('The local Homie folder belongs to a different repository. Existing files were retained.');
    }
    return true;
  }

  private async writeJournal(filename: string, remote: RemoteRepository): Promise<void> {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, repository: this.repository, remoteId: remote.id }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  private async ownsInitialization(filename: string, remote: RemoteRepository): Promise<boolean> {
    if (!await exists(filename)) return false;
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Inspect the saved Homie repository setup record.');
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    return saved.version === 1 && saved.repository === this.repository && saved.remoteId === remote.id;
  }

  private async seed(files: Record<string, string>): Promise<void> {
    assertTemplateFiles(files);
    const staging = await mkdtemp(path.join(path.dirname(this.directory), '.cheshi-homies-seed-'));
    try {
      for (const [name, text] of Object.entries(files)) {
        const target = path.join(staging, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text, { flag: 'wx' });
      }
      await this.command('git', ['init', '-b', 'main'], staging);
      await this.command('git', ['add', '--', ...Object.keys(files)], staging);
      await this.command('git', ['-c', 'user.name=Cheshi', '-c', 'user.email=homies@cheshi.local', '-c', 'commit.gpgSign=false',
        'commit', '-m', '[init] add homie configuration'], staging);
      await this.command('git', ['push', this.url, 'HEAD:refs/heads/main'], staging);
    } finally {
      // This fresh staging checkout contains only bundled templates. The user's
      // permanent checkout is never reset, cleaned, or used for initialization.
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async clone(): Promise<void> {
    const staging = await mkdtemp(path.join(path.dirname(this.directory), '.cheshi-homies-clone-'));
    try {
      const checkout = path.join(staging, 'repository');
      await this.command('git', ['clone', '--', this.url, checkout]);
      if (await exists(this.directory)) throw new Error('The Homie project path appeared during setup. Retry after inspecting it.');
      await rename(checkout, this.directory);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  private async prepare(): Promise<HomieRepositoryResult> {
    await mkdir(path.dirname(this.directory), { recursive: true });
    const lock = `${this.directory}.cheshi-lock`, journal = `${this.directory}.cheshi-setup.json`;
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Homie repository setup is already running or was interrupted. Inspect the setup lock before retrying.');
      throw error;
    }
    try {
      const local = await this.inspectLocal();
      let remote = await this.lookup(), created = false;
      let files: Record<string, string> | undefined;
      if (!remote) {
        if (local) throw new Error('The remote Homie repository is unavailable but a local checkout exists. Restore repository access or choose another local folder; existing work was retained.');
        // Validate/read bundled files before creating any external resource.
        files = await this.template();
        assertTemplateFiles(files);
        remote = await this.create();
        created = true;
        await this.writeJournal(journal, remote);
      }
      const ownsInitialization = await this.ownsInitialization(journal, remote);
      if (this.requireInitialization && !local && !created && !ownsInitialization) {
        throw new Error('This repository appeared outside this Homie setup. Existing files were retained; inspect the saved mapping before retrying.');
      }
      if (ownsInitialization) {
        const heads = await this.command('git', ['ls-remote', '--heads', this.url]);
        if (!heads) await this.seed(files ?? await this.template());
      }
      if (!local) await this.clone();
      await this.inspectLocal();
      if (await exists(journal)) await unlink(journal);
      return { repository: remote.fullName, directory: await realpath(this.directory), created };
    } finally { await rmdir(lock); }
  }
}
