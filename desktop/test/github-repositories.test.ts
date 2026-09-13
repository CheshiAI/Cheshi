import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubAuthenticationRequiredError, GitHubRepositories } from '../lib/github-repositories.mts';
import type { GitHubCommandRunner } from '../lib/github-repositories.mts';

function repository(id = 1, overrides: Record<string, unknown> = {}) {
  return { id, full_name: `team/repo-${id}`, description: null, private: true,
    clone_url: `https://github.com/team/repo-${id}.git`, ...overrides };
}

function fixture(response: unknown, account: unknown = { login: 'cheshi' }) {
  const calls: { args: string[]; options: Parameters<GitHubCommandRunner>[1] }[] = [];
  const service = new GitHubRepositories(async (args, options) => {
    calls.push({ args, options });
    return JSON.stringify(args.at(-1) === 'user' ? account : response);
  });
  return { service, calls };
}

test('lists private and public accessible repositories with bounded read-only github dot com requests', async () => {
  const f = fixture([repository(), repository(2, { private: false, description: 'Public project' })]);
  assert.deepEqual(await f.service.list(), {
    login: 'cheshi', nextPage: null, repositories: [
      { id: 1, fullName: 'team/repo-1', description: null, private: true, cloneUrl: 'https://github.com/team/repo-1.git' },
      { id: 2, fullName: 'team/repo-2', description: 'Public project', private: false, cloneUrl: 'https://github.com/team/repo-2.git' },
    ],
  });
  assert.deepEqual(f.calls.map(({ args }) => args), [
    ['api', '--hostname', 'github.com', 'user'],
    ['api', '--hostname', 'github.com', 'user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=updated&per_page=100&page=1'],
  ]);
  assert.ok(f.calls.every(({ options }) => options.timeout === 30_000 && options.env.GH_PROMPT_DISABLED === '1'));
});

test('continues full pages without eagerly fetching more repositories and handles empty accounts', async () => {
  const f = fixture(Array.from({ length: 100 }, (_, index) => repository(index + 1)));
  assert.equal((await f.service.list(3)).nextPage, 4);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await fixture([]).service.list(), { login: 'cheshi', repositories: [], nextPage: null });
});

test('rejects malformed pages before invoking the CLI', async () => {
  const f = fixture([]);
  for (const page of [null, false, '1', 0, -1, 1.5, Infinity, NaN, {}, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.service.list(page), /positive integer/u);
  }
  assert.equal(f.calls.length, 0);
});

test('rejects malformed API bodies and unsafe repository identity or clone URLs', async () => {
  for (const response of [null, {}, [null], [repository(0)], [repository(1, { private: 'true' })],
    [repository(1, { description: 3 })], [repository(1, { full_name: 'owner/../repo' })],
    [repository(1, { clone_url: 'https://token@github.com/team/repo-1.git' })],
    [repository(1, { clone_url: 'https://untrusted.example/team/repo-1.git' })],
    [repository(), repository()], Array.from({ length: 101 }, (_, index) => repository(index + 1))]) {
    await assert.rejects(fixture(response).service.list(), /invalid repository response/u);
  }
  for (const account of [null, {}, { login: '../owner' }, { login: true }]) {
    await assert.rejects(fixture([], account).service.list(), /invalid repository response/u);
  }
  await assert.rejects(new GitHubRepositories(async () => 'not json SECRET').list(), (error: Error) => {
    assert.match(error.message, /invalid repository response/u);
    assert.ok(!error.message.includes('SECRET'));
    return true;
  });
});

test('maps CLI missing, authentication, permission, network and timeout failures without exposing raw output', async () => {
  const failures: [Record<string, unknown>, RegExp, boolean][] = [
    [{ code: 'ENOENT' }, /Install GitHub CLI/u, false],
    [{ stderr: 'HTTP 401 SECRET' }, /Sign in to GitHub/u, true],
    [{ stderr: 'gh auth login SECRET' }, /Sign in to GitHub/u, true],
    [{ stderr: 'HTTP 403 SECRET' }, /organization SSO/u, false],
    [{ stderr: 'HTTP 429 SECRET' }, /rate limits/u, false],
    [{ killed: true }, /timed out/u, false],
    [{ stderr: 'connection refused SECRET' }, /connection/u, false],
  ];
  for (const [failure, pattern, authenticationRequired] of failures) {
    const service = new GitHubRepositories(async () => { throw Object.assign(new Error('SECRET'), failure); });
    await assert.rejects(service.list(), (error: Error) => {
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes('SECRET'));
      assert.equal(error instanceof GitHubAuthenticationRequiredError, authenticationRequired);
      return true;
    });
  }
});

test('clones a selected repository using canonical HTTPS and forwards only validated git depth flags', async () => {
  const f = fixture([]);
  await f.service.clone('team/project', '/projects/new project', '/projects', 5);
  assert.deepEqual(f.calls[0]!.args, ['repo', 'clone', 'https://github.com/team/project.git', '/projects/new project', '--no-upstream', '--', '--depth', '5']);
  assert.equal(f.calls[0]!.options.cwd, '/projects');
  assert.equal(f.calls[0]!.options.timeout, 120_000);
  await f.service.clone('team/project', '/projects/full', '/projects');
  assert.equal(f.calls[1]!.args.includes('--depth'), false);
  for (const fullName of ['-flag', 'owner/../repo', 'https://github.com/owner/repo', 'owner/repo\n', null]) {
    await assert.rejects(f.service.clone(fullName, '/projects/no', '/projects'), /valid GitHub repository/u);
  }
  assert.equal(f.calls.length, 2);
});
