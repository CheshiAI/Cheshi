import { expect, test } from 'bun:test';
import { dockerCommandError } from '../lib/agent-management/docker-errors.mts';

const query = ['--host', 'unix:///tmp/engine.sock', 'container', 'ls', '--all'];
test('only a missing selected context is an engine outage', () => {
  const error = Object.assign(new Error('private'), { code: 1 });
  const args = ['context', 'inspect', 'colima-cheshi'];
  for (const diagnostic of ['context "colima-cheshi": context not found',
    'context "colima-cheshi": context not found: open /private/contexts/meta/id/meta.json: no such file or directory']) {
    expect(dockerCommandError(error, diagnostic, args).kind).toBe('engine-unavailable');
    expect(dockerCommandError(error, diagnostic, ['context', 'inspect', 'other']).kind).toBe('command-failed');
    expect(dockerCommandError(error, diagnostic, ['context', 'rm', 'colima-cheshi']).kind).toBe('command-failed');
    expect(dockerCommandError(error, diagnostic, ['exec', 'worker', 'test']).kind).toBe('command-failed');
    expect(dockerCommandError(error, diagnostic, args).message).not.toContain('/private/');
  }
  for (const diagnostic of [
    'context "colima-cheshi": context not found: open /private/meta.json: permission denied',
    'context "colima-cheshi": invalid character in metadata',
    'context "colima-cheshi": context not found\nother error: open /private/meta.json: no such file or directory',
    'open /private/config.json: no such file or directory',
  ]) expect(dockerCommandError(error, diagnostic, args).kind).toBe('command-failed');
});
test('classifies daemon socket outages without confusing build or exec failures with offline status', () => {
  for (const diagnostic of [
    'Cannot connect to the Docker daemon at unix:///tmp/engine.sock. Is the docker daemon running?',
    'error during connect: Get "http://%2Ftmp%2Fengine.sock/v1.50/containers/json": dial unix /tmp/engine.sock: connect: connection refused',
    'failed to connect to the docker API at unix:///tmp/engine.sock; check if the path is correct and if the daemon is running: dial unix /tmp/engine.sock: connect: no such file or directory',
  ]) {
    const error = Object.assign(new Error('unsafe command text'), { code: 1 });
    expect(dockerCommandError(error, diagnostic, query).kind).toBe('engine-unavailable');
    expect(dockerCommandError(error, diagnostic, ['build', '.']).kind).toBe('command-failed');
    expect(dockerCommandError(error, diagnostic, ['exec', 'worker', 'test']).kind).toBe('command-failed');
  }
});

test('distinguishes CLI, permission, timeout and exit failures without exposing arbitrary diagnostics', () => {
  const make = (code: string | number, stderr = '') => dockerCommandError(Object.assign(new Error('password=private'), { code }), stderr, query);
  expect(make('ENOENT').kind).toBe('cli-missing');
  expect(make('EACCES').kind).toBe('permission-denied');
  expect(make(1, 'permission denied while trying to connect to the Docker daemon socket at unix:///tmp/engine.sock').kind).toBe('permission-denied');
  expect(make('ETIMEDOUT').kind).toBe('timeout');
  expect(dockerCommandError(Object.assign(new Error(), { killed: true }), '', query).kind).toBe('timeout');
  const failure = make(125, 'token=arbitrary-private-value\n-----BEGIN PRIVATE KEY-----\nprivate');
  expect(failure.kind).toBe('command-failed');
  expect(failure.message).toContain('exit 125');
  expect(JSON.stringify(failure)).not.toContain('private');
  expect(failure.message).not.toContain('private');
});
