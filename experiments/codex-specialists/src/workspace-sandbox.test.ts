import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWritableWorkspace } from './workspace-sandbox.ts';
import { SpecialistAgent } from './agent.ts';
import { FakeClient } from './agent-test-client.ts';
import { AgentStore } from './store.ts';

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-workspace-sandbox-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('checks writable workspace without creating metadata or probe files', () => {
  const workspace = temporary();
  assertWritableWorkspace(workspace);
  expect(readdirSync(workspace)).toEqual([]);
});

test('fails clearly when the workspace mount is missing', () => {
  expect(() => assertWritableWorkspace(join(temporary(), 'missing'))).toThrow('container mount and VM file-sharing permissions');
});

test.skipIf(process.getuid?.() === 0)('fails clearly when this user cannot write the workspace', () => {
  const workspace = temporary();
  chmodSync(workspace, 0o500);
  expect(() => assertWritableWorkspace(workspace)).toThrow('Workspace is not writable');
});

test('blocks unwritable development work before model submission without gating read-only work', async () => {
  for (const fileWrite of [true, false]) {
    const store = new AgentStore(temporary()), client = new FakeClient();
    const agent = new SpecialistAgent({ client, store, workspace: join(temporary(), 'missing'), profile: 'Developer', configuration: {
      decisionProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development', token: 'a'.repeat(64),
      instructions: 'Developer', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite, commandExecution: true },
    } });
    agent.submit('work', 'Authorized task', { roomId: 'room', conversation: 'work', goal: true });
    await agent.settled();
    expect(client.calls.some(call => call.method === 'turn/start')).toBe(!fileWrite);
    if (fileWrite) {
      expect(client.calls.some(call => call.method === 'thread/start')).toBe(false);
      expect(store.task('work')?.error).toContain('Workspace is not writable');
      expect(store.task('work')?.status).toBe('failed');
      const calls = client.calls.length;
      agent.pump();
      await agent.settled();
      expect(client.calls).toHaveLength(calls);
    }
  }
});
