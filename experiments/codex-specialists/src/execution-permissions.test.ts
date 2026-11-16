import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import { AgentStore } from './store.ts';
import { FakeClient } from './agent-test-client.ts';
import { coversPermissions, shouldRequestPermissions, parsePermissionRequest } from './execution-permissions.ts';
import type { RuntimeConfiguration } from './runtime-config.ts';
import { TaskScratch, SCRATCH_PROFILE } from './task-scratch.ts';

const directories: string[] = [];
afterEach(() => { for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture(permissions = { fileWrite: false, commandExecution: false }, store?: AgentStore) {
  const workspace = mkdtempSync(join(tmpdir(), 'cheshi-permissions-')); directories.push(workspace);
  store ??= new AgentStore(workspace);
  const client = new FakeClient();
  const configuration: RuntimeConfiguration = { permissionProtocol: 1, role: 'development', accountId: 'default', profileId: 'dev', token: 'a'.repeat(64),
    model: null, reasoningEffort: null, serviceTier: null, instructions: 'Keep instructions', permissions };
  const agent = new SpecialistAgent({ client, store, configuration, workspace, profile: 'Keep instructions' });
  return { agent, store, client, configuration };
}
const args = { fileWrite: true, commandExecution: true, reason: 'Implement and test the requested change.' };
async function request(f: ReturnType<typeof fixture>) {
  f.client.onStart = async () => {
    const result = await f.client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'request_execution_permissions', arguments: args });
    f.client.complete(); return { turn: { id: 'turn' }, result };
  };
  f.agent.submit('task', 'Implement', { roomId: 'room', conversation: 'conversation', goal: false });
  await f.agent.settled();
}
test('permission request persists without granting or starting another turn; deny survives restart', async () => {
  const f = fixture(); await request(f);
  const saved = f.store.task('task')!;
  expect(saved.status).toBe('waiting'); expect(saved.permissionRequest).toMatchObject({ ...args, status: 'pending' });
  expect(f.configuration.permissions).toEqual({ fileWrite: false, commandExecution: false });
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  expect(() => f.agent.resolvePermissions('task', 'foreign', saved.permissionRequest!.id, 'allow')).toThrow('changed');
  expect(() => f.agent.resolvePermissions('task', 'room', saved.permissionRequest!.id, 'allow')).toThrow('approved');
  f.agent.resolvePermissions('task', 'room', saved.permissionRequest!.id, 'deny');
  const reopened = new AgentStore(f.store.directory);
  expect(reopened.task('task')?.permissionRequest?.status).toBe('denied');
  expect(() => f.agent.resolvePermissions('task', 'room', saved.permissionRequest!.id, 'allow')).toThrow('already decided');
});
test('only a worker configured with the granted permissions acknowledges approval, without replay', async () => {
  const f = fixture(); await request(f);
  const next = fixture({ fileWrite: true, commandExecution: true }, new AgentStore(f.store.directory));
  const id = next.store.task('task')!.permissionRequest!.id;
  expect(next.agent.resolvePermissions('task', 'room', id, 'allow')).toEqual({ status: 'allowed' });
  expect(next.client.calls).toHaveLength(0);
  expect(next.store.task('task')?.status).toBe('waiting');
});
test('native requests from another thread cannot create a permission card', async () => {
  const f = fixture();
  f.client.onStart = async () => {
    f.client.approvalHandler!('item/fileChange/requestApproval', { threadId: 'foreign', turnId: 'turn' });
    expect(f.store.task('task')?.permissionRequest).toBeUndefined();
    f.client.approvalHandler!('item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn' });
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('task', 'Review', { roomId: 'room', conversation: 'conversation', goal: false }); await f.agent.settled();
  expect(f.store.task('task')?.permissionRequest).toMatchObject({ fileWrite: true, commandExecution: false, status: 'pending' });
});
test('strict flags and approved scratch roots preserve the project boundary', () => {
  expect(() => parsePermissionRequest({ ...args, id: 'id', status: 'pending', fileWrite: 'true' })).toThrow();
  expect(coversPermissions({ fileWrite: false, commandExecution: true }, args)).toBe(false);
  const scratch = new TaskScratch();
  try {
    const result = { activePermissionProfile: { id: SCRATCH_PROFILE }, sandbox: { type: 'workspaceWrite', networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true, writableRoots: ['/workspace', scratch.directory] } };
    scratch.assertApplied(result, '/workspace');
    expect(() => scratch.assertApplied(result)).toThrow();
    expect(() => scratch.assertApplied({ ...result, sandbox: { ...result.sandbox, writableRoots: [scratch.directory, '/outside'] } }, '/workspace')).toThrow();
    expect(scratch.config('/workspace', true)[`permissions.${SCRATCH_PROFILE}`]).toMatchObject({ filesystem: { '/workspace': 'write' } });
    expect(scratch.config('/workspace')[`permissions.${SCRATCH_PROFILE}`]).toMatchObject({ filesystem: { '/workspace': 'read' } });
  } finally { scratch.dispose(); }
});

test('native approval transport records the request but still declines the original execution', async () => {
  const { writeFileSync } = await import('node:fs');
  const { AppServerClient } = await import('./app-server-client.ts');
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-approval-rpc-')); directories.push(directory);
  const executable = join(directory, 'app-server.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
const lines = require('node:readline').createInterface({input:process.stdin});
let probe;
lines.on('line', line => {
  const value = JSON.parse(line);
  if (value.method === 'probe') { probe = value.id; console.log(JSON.stringify({ id: 999, method: 'item/fileChange/requestApproval', params: { threadId:'thread', turnId:'turn' } })); }
  else if (value.id === 999) console.log(JSON.stringify({ id:probe, result:value.result }));
});
`, { mode: 0o700 });
  const client = new AppServerClient(Bun.which('node')!, undefined, [executable]);
  const calls: string[] = []; client.handleApprovals((method, params) => { calls.push(`${method}/${params.threadId}`); });
  try {
    expect(await client.request('probe', {})).toEqual({ decision: 'decline' });
    expect(calls).toEqual(['item/fileChange/requestApproval/thread']);
    expect(client.deniedRequests).toBe(1);
  } finally { await client.close(); }
});

test('failed app-server spawn rejects requests and can close without waiting for a nonexistent process', async () => {
  const { AppServerClient } = await import('./app-server-client.ts');
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-missing-rpc-')); directories.push(directory);
  const client = new AppServerClient(join(directory, 'missing-executable'));
  let error: unknown;
  try { await client.request('initialize', {}); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('Could not start');
  await client.close();
});

test('a prior command grant permits a later file-write request without requesting granted permissions again', async () => {
  const f = fixture({ fileWrite: false, commandExecution: true });
  f.client.onStart = async () => {
    f.store.update('task', { permissionRequest: { id: 'previous', reason: 'Run tests', status: 'allowed', fileWrite: false, commandExecution: true } });
    const result = await f.client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'request_execution_permissions', arguments: args });
    expect(result).toMatchObject({ status: 'pending', fileWrite: true, commandExecution: false });
    expect(result.id).not.toBe('previous');
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('task', 'Implement', { roomId: 'room', conversation: 'conversation', goal: false }); await f.agent.settled();
  expect(f.store.task('task')?.status).toBe('waiting');
  expect(f.configuration.permissions).toEqual({ fileWrite: false, commandExecution: true });
});
test('a denied request is returned as denied without another approval card', async () => {
  const f = fixture();
  f.client.onStart = async () => {
    f.store.update('task', { permissionRequest: { ...args, id: 'denied', status: 'denied' } });
    const result = await f.client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'request_execution_permissions', arguments: args });
    expect(result).toMatchObject({ id: 'denied', status: 'denied' });
    expect(result.message).toContain('Do not repeat');
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('task', 'Implement', { roomId: 'room', conversation: 'conversation', goal: false }); await f.agent.settled();
  expect(f.store.task('task')?.permissionRequest?.id).toBe('denied');
});
test('native file request after command approval records only the missing capability', async () => {
  const f = fixture({ fileWrite: false, commandExecution: true });
  f.client.onStart = async () => {
    f.store.update('task', { permissionRequest: { id: 'old', reason: 'Run tests', status: 'allowed', fileWrite: false, commandExecution: true } });
    f.client.approvalHandler!('item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn' });
    f.client.complete(); return { turn: { id: 'turn' } };
  };
  f.agent.submit('task', 'Implement', { roomId: 'room', conversation: 'conversation', goal: false }); await f.agent.settled();
  expect(f.store.task('task')?.permissionRequest).toMatchObject({ status: 'pending', fileWrite: true, commandExecution: false });
});

test('a denied capability cannot be requested again by changing the other flag', () => {
  const denied = { ...args, id: 'denied', status: 'denied' as const };
  expect(shouldRequestPermissions(denied, { fileWrite: true, commandExecution: false })).toBe(false);
  expect(shouldRequestPermissions({ ...denied, fileWrite: false }, { fileWrite: true, commandExecution: false })).toBe(true);
});
