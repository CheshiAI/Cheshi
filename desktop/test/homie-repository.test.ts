import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, readdir, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HomieRepository } from '../lib/agent-management/homie-repository.mts';
import { HOMIE_TEMPLATE_FILES, homieRepositoryTemplate } from '../lib/agent-management/homie-repository-template.mts';
import type { RepositoryCommand, RepositoryCommandResult } from '../lib/agent-management/homie-repository-command.mts';
import { readAgentPackage } from '../lib/agent-management/packages.mts';
import { specialistAgent } from './agent-registry-fixtures';

const execute = promisify(execFile);
const templateAgent = specialistAgent();
const options = { repository: 'example-org/homie-development', template: () => homieRepositoryTemplate(templateAgent) };
const url = 'https://github.com/example-org/homie-development.git';
const success = (stdout = ''): RepositoryCommandResult => ({ code: 0, stdout, stderr: '' });
const failure = (stderr: string): RepositoryCommandResult => ({ code: 1, stdout: '', stderr });
async function rejected(operation: Promise<unknown>, message: RegExp) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(message);
}

async function fixture(run: (f: {
  base: string; directory: string; bare: string; service: HomieRepository; command: RepositoryCommand;
  calls: { command: string; args: string[] }[];
  state: { present: boolean; private: boolean | string; lookupFailure: string; failGit: string; createFailure: string };
}) => Promise<void>) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cheshi-homie-repository-')));
  const bare = path.join(base, 'remote.git'), directory = path.join(base, 'projects', 'homies');
  const state = { present: false, private: true as boolean | string, lookupFailure: '', failGit: '', createFailure: '' };
  const calls: { command: string; args: string[] }[] = [];
  const remote = () => JSON.stringify({ id: 123, full_name: 'example-org/homie-development', private: state.private });
  await execute('git', ['init', '--bare', '--initial-branch=main', bare]);
  const command: RepositoryCommand = async (cmd, args, cwd) => {
    calls.push({ command: cmd, args: [...args] });
    if (cmd === 'gh') {
      if (args.includes('POST')) {
        if (state.createFailure) return failure(state.createFailure);
        expect(args).toContain('orgs/example-org/repos');
        expect(args).toContain('private=true');
        state.present = true;
        return success(remote());
      }
      if (args.at(-1) === 'user') return success(JSON.stringify({ login: 'test-user' }));
      if (state.lookupFailure) return failure(state.lookupFailure);
      return state.present ? success(remote()) : failure('gh: Not Found (HTTP 404)');
    }
    if (state.failGit && args[0] === state.failGit) return failure('simulated transport failure');
    if (args[0] === 'remote' && args.includes('get-url')) return success(url);
    const translated = args.map(value => value === url ? bare : value);
    try { return success((await execute('git', translated, { cwd })).stdout); }
    catch (error) { return failure(String((error as { stderr?: string }).stderr)); }
  };
  try { await run({ base, bare, directory, service: new HomieRepository({ ...options, directory, run: command }), command, calls, state }); }
  finally { await rm(base, { recursive: true, force: true }); }
}

test('new private repository is seeded from deterministic packaged files and cloned to its permanent folder', async () => {
  await fixture(async f => {
    const first = await f.service.ensure();
    expect(first).toEqual({ repository: 'example-org/homie-development', directory: f.directory, created: true });
    const files = await homieRepositoryTemplate(templateAgent);
    expect(Object.keys(files).sort()).toEqual([...HOMIE_TEMPLATE_FILES].sort());
    expect(await homieRepositoryTemplate(templateAgent)).toEqual(files);
    for (const [name, content] of Object.entries(files)) expect(await readFile(path.join(f.directory, name), 'utf8')).toBe(content);
    expect((await readAgentPackage(path.join(f.directory, 'agent.json'))).instructions).toBe(templateAgent.instructions);
    expect(files['agent.json']).not.toContain('accountId');
    expect(files['agent.json']).not.toContain('assignments');
    expect((await execute('git', ['status', '--porcelain'], { cwd: f.directory })).stdout).toBe('');
    expect(await readdir(path.dirname(f.directory))).toEqual(['homies']);
    expect(f.calls.filter(call => call.args.includes('POST'))).toHaveLength(1);
  });
});

test('repeated and concurrent calls reuse the same repository and keep tracked edits and untracked files', async () => {
  await fixture(async f => {
    const another = new HomieRepository({ ...options, directory: f.directory, run: f.command });
    const [first, second] = await Promise.all([f.service.ensure(), another.ensure()]);
    expect(second).toEqual(first);
    await writeFile(path.join(f.directory, 'README.md'), 'User edits');
    await writeFile(path.join(f.directory, 'local-draft.md'), 'User draft');
    expect((await f.service.ensure()).created).toBe(false);
    expect(await readFile(path.join(f.directory, 'README.md'), 'utf8')).toBe('User edits');
    expect(await readFile(path.join(f.directory, 'local-draft.md'), 'utf8')).toBe('User draft');
    expect(f.calls.filter(call => call.args.includes('POST'))).toHaveLength(1);
    expect(f.calls.filter(call => call.args[0] === 'clone')).toHaveLength(1);
    expect(f.calls.filter(call => call.args[0] === 'push')).toHaveLength(1);
  });
});

test('existing remote is cloned without recreation or template overwrite', async () => {
  await fixture(async f => {
    await f.service.ensure();
    const second = path.join(f.base, 'second', 'homies');
    const start = f.calls.length;
    const result = await new HomieRepository({ ...options, directory: second, run: f.command }).ensure();
    expect(result.created).toBe(false);
    expect(f.calls.slice(start).some(call => call.args.includes('POST') || call.args[0] === 'push')).toBe(false);
    expect(await readFile(path.join(second, 'README.md'), 'utf8')).toBe((await homieRepositoryTemplate(templateAgent))['README.md']!);
  });
});

for (const error of ['HTTP 401 Bad credentials', 'HTTP 403 SSO authorization', 'HTTP 429 rate limit', 'network connection refused']) {
  test(`lookup failure does not create a repository: ${error}`, async () => {
    await fixture(async f => {
      f.state.lookupFailure = error;
      await rejected(f.service.ensure(), /GitHub|repository/i);
      expect(f.calls.some(call => call.args.includes('POST'))).toBe(false);
      expect(await readdir(path.dirname(f.directory))).toEqual([]);
    });
  });
}

for (const visibility of [false, 'true']) {
  test(`existing repository requires literal private=true: ${visibility}`, async () => {
    await fixture(async f => {
      f.state.present = true; f.state.private = visibility;
      await rejected(f.service.ensure(), /must be private/);
      expect(f.calls).toHaveLength(1);
    });
  });
}

test('masked 404 followed by denied creation preserves data and does not clone', async () => {
  await fixture(async f => {
    f.state.createFailure = 'HTTP 403 organization permissions';
    await rejected(f.service.ensure(), /denied/);
    expect(f.calls.some(call => call.command === 'git')).toBe(false);
    expect(await readdir(path.dirname(f.directory))).toEqual([]);
  });
});

for (const step of ['push', 'clone']) {
  test(`retry after ${step} failure resumes the created repository without duplicates`, async () => {
    await fixture(async f => {
      f.state.failGit = step;
      await rejected(f.service.ensure(), /Could not prepare/);
      expect(f.state.present).toBe(true);
      expect(await readdir(path.dirname(f.directory))).toEqual(['homies.cheshi-setup.json']);
      f.state.failGit = '';
      const result = await new HomieRepository({ ...options, directory: f.directory, run: f.command }).ensure();
      expect(result.created).toBe(false);
      expect(f.calls.filter(call => call.args.includes('POST'))).toHaveLength(1);
      expect((await execute('git', ['rev-list', '--all', '--count'], { cwd: f.bare })).stdout.trim()).toBe('1');
      expect(await readdir(path.dirname(f.directory))).toEqual(['homies']);
    });
  });
}

test('occupied folders, symlinks and another repository are never overwritten', async () => {
  await fixture(async f => {
    await mkdir(f.directory, { recursive: true });
    await writeFile(path.join(f.directory, 'keep.txt'), 'keep');
    await rejected(f.service.ensure(), /Could not prepare/);
    expect(f.calls.some(call => call.command === 'gh')).toBe(false);
    expect(await readFile(path.join(f.directory, 'keep.txt'), 'utf8')).toBe('keep');
    const linked = path.join(f.base, 'linked');
    await createSymbolicLink(f.directory, linked);
    await rejected(new HomieRepository({ ...options, directory: linked, run: f.command }).ensure(), /occupied/);
    await execute('git', ['init', f.directory]);
    const foreign: RepositoryCommand = async (command, args, cwd) => args.includes('get-url')
      ? success('https://github.com/another/project.git') : f.command(command, args, cwd);
    await rejected(new HomieRepository({ ...options, directory: f.directory, run: foreign }).ensure(), /different repository/);
  });
});

test('a stale setup lock is not stolen and no remote action runs', async () => {
  await fixture(async f => {
    await mkdir(`${f.directory}.cheshi-lock`, { recursive: true });
    await rejected(f.service.ensure(), /setup lock/);
    expect(f.calls).toHaveLength(0);
    expect(await readdir(path.dirname(f.directory))).toEqual(['homies.cheshi-lock']);
  });
});

test('missing templates fail before creating a remote repository', async () => {
  await fixture(async f => {
    await rejected(new HomieRepository({ ...options, directory: f.directory, run: f.command,
      template: async () => { throw new Error('Missing packaged templates'); } }).ensure(), /Missing packaged/);
    expect(f.calls.some(call => call.args.includes('POST'))).toBe(false);
  });
});

test('a repository that appears after name planning is not adopted for a new Homie', async () => {
  await fixture(async f => {
    await f.service.ensure();
    const start = f.calls.length;
    await rejected(new HomieRepository({ ...options, directory: path.join(f.base, 'new-homie'),
      requireInitialization: true, run: f.command }).ensure(), /appeared outside/);
    expect(f.calls.slice(start).some(call => call.args[0] === 'clone' || call.args[0] === 'push')).toBe(false);
  });
});
