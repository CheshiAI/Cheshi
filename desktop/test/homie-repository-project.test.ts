import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HomieRepositoryProjects } from '../lib/agent-management/homie-repository-project.mts';
import type { RepositoryCommand } from '../lib/agent-management/homie-repository-command.mts';
import { specialistAgent } from './agent-registry-fixtures';

async function rejected(operation: Promise<unknown>, text: RegExp) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(text);
}

async function fixture(testCase: (f: {
  config: { stateDirectory: string; projectsDirectory: string; run: RepositoryCommand };
  service: HomieRepositoryProjects; calls: string[][];
  state: { id: number; login: string; error: string; membership: string; occupied: Set<string> };
}) => Promise<void>) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'homie-account-repos-')));
  const state = { id: 101, login: 'alice', error: '', membership: 'active', occupied: new Set<string>() };
  const calls: string[][] = [];
  const run: RepositoryCommand = async (command, args) => {
    expect(command).toBe('gh'); calls.push(args);
    const endpoint = args.at(-1)!;
    if (state.error) return { code: 1, stdout: '', stderr: state.error };
    if (endpoint === 'user') return { code: 0, stdout: JSON.stringify({ id: state.id, login: state.login }), stderr: '' };
    if (endpoint.startsWith('user/memberships/orgs/')) return { code: 0,
      stdout: JSON.stringify({ state: state.membership, organization: { login: endpoint.split('/').at(-1) } }), stderr: '' };
    if (state.occupied.has(endpoint.toLowerCase())) return { code: 0, stdout: '{}', stderr: '' };
    return { code: 1, stdout: '', stderr: 'HTTP 404' };
  };
  const config = { stateDirectory: path.join(base, 'mappings'), projectsDirectory: path.join(base, 'projects'), run };
  try { await testCase({ config, service: new HomieRepositoryProjects(config), calls, state }); }
  finally { await rm(base, { recursive: true, force: true }); }
}

const agent = { ...specialistAgent(), name: 'Development' };
const another = { ...agent, id: 'b1234567-1234-1234-1234-123456789abc' };

test('fresh users default to their authenticated GitHub account with a short repository name', async () => {
  await fixture(async f => {
    const plan = await f.service.plan(agent);
    expect(plan.repository).toBe('alice/Homie-development');
    expect(path.basename(plan.directory)).toBe('homie-development');
    expect(plan.accountId).toBe(101);
    expect(await new HomieRepositoryProjects(f.config).local(agent.id)).toEqual(plan);
    expect(f.calls.some(args => args.at(-1) === 'repos/alice/Homie-development')).toBe(true);
    f.state.id = 202; f.state.login = 'bob';
    const otherUser = new HomieRepositoryProjects({ ...f.config, stateDirectory: path.join(f.config.stateDirectory, 'bob'),
      projectsDirectory: path.join(f.config.projectsDirectory, 'bob') });
    expect((await otherUser.plan(agent)).repository).toBe('bob/Homie-development');
    expect(f.calls.some(args => args.includes('POST'))).toBe(false);
  });
});

test('remote, local and reserved name collisions append a short ID without adopting existing data', async () => {
  await fixture(async f => {
    const first = await f.service.plan(agent);
    const second = await f.service.plan(another);
    expect(first.repository).toBe('alice/Homie-development');
    expect(second.repository).toBe('alice/Homie-development-b1234567');
    f.state.occupied.add('repos/alice/homie-review');
    expect((await f.service.plan({ ...agent, id: 'c1234567-1234-1234-1234-123456789abc', name: 'review' })).repository)
      .toBe('alice/Homie-review-c1234567');
    await mkdir(path.join(f.config.projectsDirectory, 'homie-research'), { recursive: true });
    expect((await f.service.plan({ ...agent, id: 'd1234567-1234-1234-1234-123456789abc', name: 'research' })).repository)
      .toBe('alice/Homie-research-d1234567');
  });
});

test('concurrent planning and retries after renaming keep the same reserved repository', async () => {
  await fixture(async f => {
    const other = new HomieRepositoryProjects(f.config);
    const [a, b] = await Promise.all([f.service.plan(agent), other.plan({ ...agent, name: 'Renamed' })]);
    expect(a).toEqual(b);
    expect(await new HomieRepositoryProjects(f.config).plan({ ...agent, name: 'Again' })).toEqual(a);
    expect((await readdir(f.config.stateDirectory)).filter(file => file.endsWith('.json'))).toHaveLength(1);
  });
});

test('an explicit organization choice is local and only applies to the account that chose it', async () => {
  await fixture(async f => {
    await f.service.setOwner('example-team');
    expect((await f.service.plan(agent)).repository).toBe('example-team/Homie-development');
    f.state.id = 202; f.state.login = 'bob';
    expect((await f.service.plan({ ...another, name: 'Review' })).repository).toBe('bob/Homie-review');
    await rejected(f.service.plan(agent), /another GitHub account/);
  });
});

test('inactive organization memberships and authentication failures cannot choose a target', async () => {
  await fixture(async f => {
    f.state.membership = 'pending';
    await rejected(f.service.setOwner('example-team'), /active membership/);
    f.state.error = 'HTTP 401 Bad credentials';
    await rejected(f.service.plan(agent), /Sign in to GitHub/);
    expect(f.calls.some(args => args.at(-1)?.startsWith('repos/'))).toBe(false);
  });
});

test('legacy owner mappings require a local choice before binding to the authenticated account', async () => {
  await fixture(async f => {
    await mkdir(f.config.stateDirectory);
    const repository = `example-team/homie-development-${agent.id}`;
    const filename = path.join(f.config.stateDirectory, `${agent.id}.json`);
    const legacy = { agentId: agent.id, repository, directory: path.join(f.config.projectsDirectory, repository.split('/')[1]!) };
    await writeFile(filename, JSON.stringify(legacy));
    await rejected(f.service.plan(agent), /Confirm the existing/);
    await f.service.setOwner('example-team');
    expect(await f.service.plan(agent)).toEqual({ ...legacy, accountId: 101 });
    expect(JSON.parse(await readFile(filename, 'utf8')).accountId).toBe(101);
  });
});

test('saved lowercase repository mappings are reused and reserve their existing local folders', async () => {
  await fixture(async f => {
    await mkdir(f.config.stateDirectory);
    const filename = path.join(f.config.stateDirectory, `${agent.id}.json`);
    const saved = { agentId: agent.id, repository: 'alice/homie-development',
      directory: path.join(f.config.projectsDirectory, 'homie-development'), accountId: 101 };
    const original = JSON.stringify(saved);
    await writeFile(filename, original);
    expect(await f.service.local(agent.id)).toEqual(saved);
    expect(await f.service.plan(agent)).toEqual(saved);
    expect(await readFile(filename, 'utf8')).toBe(original);
    expect(f.calls.some(args => args.at(-1)?.startsWith('repos/'))).toBe(false);
    expect((await f.service.plan(another)).repository).toBe('alice/Homie-development-b1234567');
  });
});

test('invalid mappings cannot redirect preparation outside the selected project directory', async () => {
  await fixture(async f => {
    const plan = await f.service.plan(agent);
    const filename = path.join(f.config.stateDirectory, `${agent.id}.json`);
    const malformed = JSON.stringify({ ...plan, directory: f.config.stateDirectory });
    await writeFile(filename, malformed);
    await rejected(f.service.ensure(agent), /saved Homie repository mapping/);
    expect(await readFile(filename, 'utf8')).toBe(malformed);
  });
});

test('remote access errors do not become name collisions or produce a persisted mapping', async () => {
  await fixture(async f => {
    const run: RepositoryCommand = (command, args, cwd) => args.at(-1)?.startsWith('repos/')
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 403 SSO authorization' }) : f.config.run(command, args, cwd);
    await rejected(new HomieRepositoryProjects({ ...f.config, run }).plan(agent), /denied/);
    expect((await readdir(f.config.stateDirectory)).filter(file => file.endsWith('.json'))).toHaveLength(0);
  });
});
