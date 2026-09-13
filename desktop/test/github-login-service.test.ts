import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { GitHubLoginService } from '../lib/github-login-service.mts';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean { this.signals.push(signal); return true; }
  close(code: number | null = 0): void {
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

function fixture(options: { env?: NodeJS.ProcessEnv; startupTimeoutMs?: number; attemptTimeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const commands: { command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }[] = [];
  const opened: string[] = [];
  const service = new GitHubLoginService({
    env: {}, ...options,
    spawn: (command, args, spawnOptions) => {
      commands.push({ command, args, options: spawnOptions });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    openExternal: async (url) => { opened.push(url); },
  });
  return { service, children, commands, opened };
}

function item<T>(items: T[], index: number): T {
  const value = items[index];
  assert.ok(value !== undefined);
  return value;
}

function code(child: FakeChild): void {
  child.stderr.write('! First copy your one-time code: ABCD-1234\n');
}

test('device login starts once, parses split output, and opens only the fixed GitHub URL', async () => {
  const { service, children, commands, opened } = fixture();
  assert.equal(service.start().state, 'starting');
  service.start();
  assert.equal(commands.length, 1);
  assert.deepEqual(item(commands, 0).args, ['auth', 'login', '--hostname', 'github.com', '--web', '--skip-ssh-key']);
  item(children, 0).stderr.write('! First copy your one-');
  item(children, 0).stderr.write('time code: ABCD-');
  item(children, 0).stderr.write('1234\nOpen this URL: https://untrusted.invalid\n');
  assert.deepEqual(service.status(), { state: 'waiting', userCode: 'ABCD-1234', error: null });
  assert.deepEqual(opened, []);
  await service.openBrowser();
  assert.deepEqual(opened, ['https://github.com/login/device']);
  item(children, 0).close();
  assert.deepEqual(service.status(), { state: 'complete', userCode: null, error: null });
  service.dispose();
});

test('login clears prompt and debug environment overrides while preserving configuration paths', () => {
  const { service, commands } = fixture({ env: {
    GH_DEBUG: 'api', GH_FORCE_TTY: '100%', GH_PROMPT_DISABLED: '1', GIT_DIR: '/other/repo',
    GIT_CONFIG_COUNT: '1', GH_CONFIG_DIR: '/custom/gh', PATH: '/usr/bin', FORCE_COLOR: '1',
  } });
  service.start();
  assert.deepEqual(item(commands, 0).options.env, { GH_CONFIG_DIR: '/custom/gh', PATH: '/usr/bin', NO_COLOR: '1', TERM: 'dumb' });
  service.dispose();
});

test('clipboard-enabled CLI output supplies a code across split chunks', () => {
  const { service, children } = fixture();
  service.start();
  item(children, 0).stderr.write('! One-time code (ABCD-');
  item(children, 0).stderr.write('1234) copied to clip');
  assert.equal(service.status().state, 'starting');
  item(children, 0).stderr.write('board\n');
  assert.deepEqual(service.status(), { state: 'waiting', userCode: 'ABCD-1234', error: null });
  service.dispose();
});

test('post-spawn setup failure releases and terminates the child before retry', () => {
  const child = new FakeChild();
  child.stdout.resume = () => { throw new Error('setup failed'); };
  let calls = 0;
  const service = new GitHubLoginService({ env: {}, openExternal: async () => {},
    spawn: () => { calls++; return child as unknown as ChildProcessWithoutNullStreams; },
  });
  assert.equal(service.start().state, 'error');
  assert.deepEqual(child.signals, ['SIGTERM']);
  service.start();
  assert.equal(calls, 2);
  service.dispose();
});

test('environment token authentication is explained without spawning or exposing the token', () => {
  const { service, commands } = fixture({ env: { GH_TOKEN: 'test-secret-value' } });
  const state = service.start();
  assert.equal(state.state, 'error');
  assert.match(state.error ?? '', /environment token/);
  assert.doesNotMatch(JSON.stringify(state), /test-secret-value/);
  assert.equal(commands.length, 0);
});

test('cancellation and retry ignore late output and close events from the old process', () => {
  const { service, children } = fixture();
  service.start();
  code(item(children, 0));
  service.cancel();
  assert.deepEqual(item(children, 0).signals, ['SIGTERM']);
  assert.equal(service.status().state, 'idle');
  service.start();
  code(item(children, 0));
  item(children, 0).close(1);
  item(children, 0).emit('error', new Error('late error'));
  assert.equal(service.status().state, 'starting');
  code(item(children, 1));
  assert.equal(service.status().state, 'waiting');
  service.dispose();
});

test('disposing terminates its child and prevents future sign-in attempts', () => {
  const { service, children } = fixture();
  service.start();
  service.dispose();
  assert.equal(service.start().state, 'idle');
  assert.equal(children.length, 1);
  assert.deepEqual(item(children, 0).signals, ['SIGTERM']);
  item(children, 0).close();
  assert.equal(service.status().state, 'idle');
});

test('missing CLI and process failures expose actionable, sanitized errors', () => {
  const { service, children } = fixture();
  service.start();
  item(children, 0).emit('error', Object.assign(new Error('secret command details'), { code: 'ENOENT' }));
  assert.match(service.status().error ?? '', /Install GitHub CLI/);
  service.start();
  item(children, 1).stderr.write('private diagnostic credentials should not be displayed');
  item(children, 1).close(1);
  assert.deepEqual(service.status(), { state: 'error', userCode: null, error: 'GitHub sign-in did not complete. Try again.' });
  service.dispose();
});

test('bounded diagnostic output still accepts a later valid device code', () => {
  const { service, children } = fixture();
  service.start();
  item(children, 0).stderr.write('diagnostic text '.repeat(10_000));
  code(item(children, 0));
  assert.equal(service.status().userCode, 'ABCD-1234');
  const snapshot = service.status();
  snapshot.userCode = 'changed';
  assert.equal(service.status().userCode, 'ABCD-1234');
  service.dispose();
});

test('startup timeout terminates a process that never supplies a code', async () => {
  const { service, children } = fixture({ startupTimeoutMs: 5 });
  service.start();
  await delay(20);
  assert.equal(service.status().state, 'error');
  assert.match(service.status().error ?? '', /did not provide a sign-in code/);
  assert.deepEqual(item(children, 0).signals, ['SIGTERM']);
  code(item(children, 0));
  assert.equal(service.status().state, 'error');
  service.dispose();
});

test('receiving a code cancels startup timeout but overall expiration remains enforced', async () => {
  const { service, children } = fixture({ startupTimeoutMs: 5, attemptTimeoutMs: 40 });
  service.start();
  code(item(children, 0));
  await delay(15);
  assert.equal(service.status().state, 'waiting');
  await delay(40);
  assert.match(service.status().error ?? '', /expired/);
  assert.equal(service.status().userCode, null);
  service.dispose();
});

test('browser launch failure is sanitized and preserves the code for manual sign-in', async () => {
  const child = new FakeChild();
  const service = new GitHubLoginService({ env: {},
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    openExternal: async () => { throw new Error('private operating system details'); },
  });
  service.start();
  code(child);
  let error: unknown;
  try { await service.openBrowser(); } catch (cause) { error = cause; }
  assert.ok(error instanceof Error);
  assert.match(error.message, /browser could not open/);
  assert.doesNotMatch(error.message, /private operating/);
  assert.equal(service.status().state, 'waiting');
  service.dispose();
});

test('the browser cannot open before a sign-in code is available', async () => {
  const { service, opened } = fixture();
  let error: unknown;
  try { await service.openBrowser(); } catch (cause) { error = cause; }
  assert.ok(error instanceof Error);
  assert.match(error.message, /get a code first/);
  assert.deepEqual(opened, []);
});
