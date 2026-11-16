import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClient } from './agent-test-client';
import { AgentStore } from './store';
import { SpecialistAgent } from './agent';
import { WorkerCollaboration } from './collaboration';
import { parseEnabledPackTools, packToolAllowed } from './pack-tools';

test('pack tool selections validate known capabilities and preserve built-in permission tools', () => {
  expect(parseEnabledPackTools(undefined)).toBeUndefined();
  expect(() => parseEnabledPackTools(['unknown'])).toThrow();
  expect(packToolAllowed([], 'request_permissions')).toBe(true);
  expect(packToolAllowed([], 'ask_agent')).toBe(false);
  expect(packToolAllowed(['collaboration'], 'request_verification')).toBe(false);
  expect(packToolAllowed(['collaboration', 'verification'], 'request_verification')).toBe(true);
  expect(packToolAllowed(undefined, 'ask_agent')).toBe(true);
});

test('disabled groups are absent from new thread tools and blocked on retained-thread calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homie-tools-'));
  const client = new FakeClient(), store = new AgentStore(directory);
  const configuration = { profileId: 'test', accountId: 'default', role: 'custom', token: 'a'.repeat(64), instructions: 'Test',
    model: null, reasoningEffort: null, serviceTier: null, enabledTools: [], permissions: { fileWrite: false, commandExecution: false } };
  let agent = new SpecialistAgent({ client, store, profile: 'Test', workspace: directory, configuration,
    collaboration: new WorkerCollaboration(store, 'test', directory) });
  let denied = 0;
  client.onStart = async () => {
    let error: unknown;
    try { await client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'ask_agent', arguments: {} }); }
    catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain('disabled in the Homie pack'); denied++;
    client.complete(); return { turn: { id: 'turn' } };
  };
  try {
    agent.submit('first', 'Inspect', { roomId: 'room', conversation: 'conversation', goal: false }); await agent.settled();
    const start = client.calls.find(call => call.method === 'thread/start')!;
    expect(start.params.dynamicTools).toEqual([]);
    agent.disposeScratch();
    agent = new SpecialistAgent({ client, store, profile: 'Test', workspace: directory, configuration,
      collaboration: new WorkerCollaboration(store, 'test', directory) });
    agent.submit('second', 'Inspect again', { roomId: 'room', conversation: 'conversation', goal: false }); await agent.settled();
    expect(client.calls.some(call => call.method === 'thread/resume')).toBe(true);
    expect(denied).toBe(2);
  } finally { agent.disposeScratch(); await rm(directory, { recursive: true, force: true }); }
});
