import { execFile } from 'node:child_process';
import type { GitHubRepository, GitHubRepositoryPage } from '../shared/workspace-management.ts';

interface GitHubCommandOptions {
  cwd?: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
}
export type GitHubCommandRunner = (args: string[], options: GitHubCommandOptions) => Promise<string>;

const PAGE_SIZE = 100;
const INVALID_RESPONSE = 'GitHub returned an invalid repository response. Please try again.';
const OWNER = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/u;
const REPOSITORY = /^[a-zA-Z0-9_.-]{1,100}$/u;

export class GitHubAuthenticationRequiredError extends Error {
  constructor() {
    super('Sign in to GitHub to browse your repositories.');
    this.name = 'GitHubAuthenticationRequiredError';
  }
}

export function githubRepositoryName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Choose a valid GitHub repository.');
  const [owner, repository, extra] = value.split('/');
  if (!owner || !repository || extra !== undefined || !OWNER.test(owner) || !REPOSITORY.test(repository)
    || repository === '.' || repository === '..') {
    throw new Error('Choose a valid GitHub repository.');
  }
  return value;
}

function githubEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'GH_DEBUG')),
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', NO_COLOR: '1',
  };
}

const runGitHubCommand: GitHubCommandRunner = (args, options) => new Promise((resolve, reject) => {
  execFile('gh', args, { ...options, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' },
    (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
});

function githubCommandError(error: unknown): Error {
  const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (failure.code === 'ENOENT') return new Error('Install GitHub CLI (gh), then sign in with gh auth login --hostname github.com.');
  if (failure.killed === true) return new Error('GitHub timed out. Check your connection and try again.');
  const detail = [failure.message, failure.stderr].filter((value) => typeof value === 'string').join(' ');
  if (/HTTP 401|Bad credentials|gh auth login|not logged|authentication required/iu.test(detail)) {
    return new GitHubAuthenticationRequiredError();
  }
  if (/HTTP 403|HTTP 429|rate limit|SAML|SSO/iu.test(detail)) {
    return new Error('GitHub denied this request. Check repository access, organization SSO authorization, or API rate limits.');
  }
  return new Error('GitHub could not complete the request. Check your connection and repository access, then retry.');
}

function parseJson(output: string): unknown {
  try { return JSON.parse(output) as unknown; }
  catch { throw new Error(INVALID_RESPONSE); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_RESPONSE);
  return value as Record<string, unknown>;
}

function repositoryFromResponse(value: unknown): GitHubRepository {
  const repository = record(value);
  if (!Number.isSafeInteger(repository.id) || (repository.id as number) <= 0
    || typeof repository.private !== 'boolean'
    || (repository.description !== null && typeof repository.description !== 'string')) {
    throw new Error(INVALID_RESPONSE);
  }
  let fullName: string;
  try { fullName = githubRepositoryName(repository.full_name); }
  catch { throw new Error(INVALID_RESPONSE); }
  const cloneUrl = `https://github.com/${fullName}.git`;
  if (repository.clone_url !== cloneUrl) throw new Error(INVALID_RESPONSE);
  return { id: repository.id as number, fullName, description: repository.description, private: repository.private, cloneUrl };
}

export class GitHubRepositories {
  private readonly run: GitHubCommandRunner;

  constructor(run: GitHubCommandRunner = runGitHubCommand) { this.run = run; }

  private async command(args: string[], timeout: number, cwd?: string): Promise<string> {
    try { return await this.run(args, { timeout, ...(cwd ? { cwd } : {}), env: githubEnvironment() }); }
    catch (error) { throw githubCommandError(error); }
  }

  async list(page: unknown = 1): Promise<GitHubRepositoryPage> {
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Repository page must be a positive integer.');
    }
    const account = record(parseJson(await this.command(['api', '--hostname', 'github.com', 'user'], 30_000)));
    if (typeof account.login !== 'string' || !OWNER.test(account.login)) throw new Error(INVALID_RESPONSE);
    const endpoint = `user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=updated&per_page=${PAGE_SIZE}&page=${page}`;
    const response = parseJson(await this.command(['api', '--hostname', 'github.com', endpoint], 30_000));
    if (!Array.isArray(response) || response.length > PAGE_SIZE) throw new Error(INVALID_RESPONSE);
    const repositories = response.map(repositoryFromResponse);
    if (new Set(repositories.map(({ id }) => id)).size !== repositories.length) throw new Error(INVALID_RESPONSE);
    return { repositories, nextPage: repositories.length === PAGE_SIZE ? page + 1 : null, login: account.login };
  }

  async clone(fullName: unknown, destination: string, parent: string, depth?: number): Promise<void> {
    const repository = githubRepositoryName(fullName);
    const args = ['repo', 'clone', `https://github.com/${repository}.git`, destination, '--no-upstream'];
    if (depth !== undefined) args.push('--', '--depth', String(depth));
    await this.command(args, 120_000, parent);
  }
}
