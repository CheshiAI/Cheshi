import { expect, test } from 'bun:test';
import { createDockerAgentEngine, parseDockerAgent, redactAgentLogs } from '../lib/agent-management/docker.mts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';
import { parseManagedAgent } from '../shared/agent-management.ts';

const id = 'a'.repeat(64);
function container() {
  return { Id: id, Name: '/cheshi-verifier', Config: { Image: 'verifier:test', Labels: {
    'com.docker.compose.project': 'cheshi-codex-specialists-test', 'com.docker.compose.service': 'verifier',
    'com.docker.compose.oneoff': 'False',
  } }, State: { Status: 'running' }, NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '47832' }] } } };
}
async function rejected(operation: Promise<unknown>, text: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(text);
}
function fixture() {
  const calls: string[][] = [];
  let raw = container(), host = 'unix:///tmp/engine.sock';
  const run: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === 'context' && args[1] === 'ls') return JSON.stringify({ Name: 'colima-cheshi', DockerEndpoint: host });
    if (args[0] === 'context' && args[1] === 'inspect') return JSON.stringify([{ Endpoints: { docker: { Host: host } } }]);
    if (args.includes('inspect')) return JSON.stringify([raw]);
    if (args.includes('ls')) return JSON.stringify({ ID: id });
    if (args.includes('logs')) return 'worker-ready';
    return '';
  };
  return { calls, engine: createDockerAgentEngine(run), raw: () => raw,
    replace: (next: ReturnType<typeof container>) => { raw = next; }, remote: () => { host = 'ssh://remote'; } };
}

test('adopts only the labelled verifier and discovers only loopback worker APIs', () => {
  const raw = container();
  expect(parseDockerAgent(raw).endpoint).toBe('http://127.0.0.1:47832');
  raw.NetworkSettings.Ports['8787/tcp'][0]!.HostIp = '0.0.0.0';
  expect(parseDockerAgent(raw).endpoint).toBeNull();
  raw.Config.Labels['com.docker.compose.project'] = 'unrelated';
  expect(() => parseDockerAgent(raw)).toThrow('not a managed');
  raw.Config.Labels['com.docker.compose.project'] = 'cheshi-codex-specialists-test';
  raw.Config.Labels['com.docker.compose.oneoff'] = 'True';
  expect(() => parseDockerAgent(raw)).toThrow('not a managed');
});

test('preserves exact Docker execution identity through IPC and rejects unusable start timestamps', () => {
  const raw = container();
  const first = '2026-10-09T01:00:00.123456789Z', second = '2026-10-09T01:00:00.123456790Z';
  const inspect = (StartedAt: unknown) => parseManagedAgent(parseDockerAgent({ ...raw, State: { ...raw.State, StartedAt } }));
  expect(inspect(first).startedAt).toBe(first);
  expect(inspect(second).startedAt).toBe(second);
  expect(inspect(first).id).toBe(inspect(second).id);
  for (const invalid of [undefined, null, true, 'invalid', '0001-01-01T00:00:00Z']) expect(inspect(invalid).startedAt).toBeUndefined();
});

test('carries a specialist label through the public contract without deriving identity from its name', async () => {
  const f = fixture();
  const profileId = 'a1234567-1234-1234-1234-123456789abc';
  f.raw().Name = `/cheshi-agent-${profileId}-project`;
  Object.assign(f.raw().Config.Labels, { 'ai.cheshi.agent': profileId });
  expect(parseManagedAgent(parseDockerAgent(f.raw()))).not.toHaveProperty('profileId');
  Object.assign(f.raw().Config.Labels, { 'ai.cheshi.worker': 'specialist-v1' });
  f.raw().Config.Labels['com.docker.compose.project'] = 'not-compose';
  const workers = await f.engine.list('docker:colima-cheshi');
  expect(workers).toHaveLength(1);
  expect(parseManagedAgent(workers[0])).toMatchObject({ id, profileId, name: f.raw().Name.slice(1) });
  expect(() => parseManagedAgent({ ...workers[0], profileId: '../invalid' })).toThrow('Invalid agent ID');
});

test('pins every engine command to its context and never deletes containers or volumes', async () => {
  const f = fixture();
  expect((await f.engine.engines())[0]?.id).toBe('docker:colima-cheshi');
  expect((await f.engine.list('docker:colima-cheshi'))[0]?.id).toBe(id);
  await f.engine.control('docker:colima-cheshi', id, 'stop');
  expect(f.calls.at(-1)).toEqual(['--context', 'colima-cheshi', 'container', 'stop', '--time', '15', id]);
  expect(await f.engine.logs('docker:colima-cheshi', id)).toBe('worker-ready');
  expect(f.calls.every(args => args[0] === 'context' || args.slice(0, 2).join(' ') === '--context colima-cheshi')).toBe(true);
  expect(f.calls.flat().some(arg => ['rm', 'down', 'volume', 'prune', 'compose'].includes(arg))).toBe(false);
});

test('revalidates identity before mutation and refuses remote contexts and short IDs', async () => {
  const f = fixture();
  f.raw().Config.Labels['com.docker.compose.service'] = 'database';
  await rejected(f.engine.control('docker:colima-cheshi', id, 'stop'), 'not a managed');
  expect(f.calls.some(args => args.includes('stop'))).toBe(false);
  f.replace(container()); f.remote();
  await rejected(f.engine.control('docker:colima-cheshi', id, 'stop'), 'Only local');
  expect(f.calls.some(args => args.includes('stop'))).toBe(false);
  await rejected(f.engine.inspect('docker:colima-cheshi', 'verifier'), 'full Docker');
});

test('rejects stale container state and omits Compose one-off login containers', async () => {
  const f = fixture();
  await rejected(f.engine.control('docker:colima-cheshi', id, 'start'), 'state changed');
  f.raw().Config.Labels['com.docker.compose.oneoff'] = 'True';
  expect(await f.engine.list('docker:colima-cheshi')).toEqual([]);
});

test('redacts common credential forms without exposing them in logs', () => {
  const token = `sk-proj-${'x'.repeat(30)}`;
  const logs = redactAgentLogs(`ready\n${token}\n{"refresh_token":"fixture-hidden"}\nAuthorization: Bearer fixture-token`);
  expect(logs).toContain('ready');
  expect(logs).not.toContain(token);
  expect(logs).not.toContain('fixture-hidden');
  expect(logs).not.toContain('fixture-token');
});

test('container shell pins its verified socket and full ID without elevating the container user', async () => {
  const f = fixture();
  const command = await f.engine.terminalCommand!('docker:colima-cheshi', id);
  expect(f.calls.at(-1)).toEqual(['--host', 'unix:///tmp/engine.sock', 'container', 'inspect', id]);
  expect(command).toContain("'--host' 'unix:///tmp/engine.sock'");
  expect(command).toContain(`'exec' '--interactive' '--tty' '--env' 'TERM=xterm-256color' '${id}' '/bin/sh'`);
  expect(command).not.toContain('--privileged');
  expect(command).not.toContain('--user');
  f.raw().State.Status = 'exited';
  await rejected(f.engine.terminalCommand!('docker:colima-cheshi', id), 'Start the selected container');
  f.replace(container()); f.raw().Config.Labels['com.docker.compose.service'] = 'unrelated';
  await rejected(f.engine.terminalCommand!('docker:colima-cheshi', id), 'not a managed');
  f.replace(container()); f.remote();
  await rejected(f.engine.terminalCommand!('docker:colima-cheshi', id), 'Only local');
});
