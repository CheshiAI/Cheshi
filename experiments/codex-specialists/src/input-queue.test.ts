import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent.ts';
import { AgentStore } from './store.ts';
import { FakeClient } from './agent-test-client.ts';
import { createDeferred } from './protocol.ts';
const directories: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), 'cheshi-input-queue-')); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });

function goalSetup(directory = temporary()) {
  const store = new AgentStore(directory), client = new FakeClient();
  const agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'Follow the user goal.',
    configuration: { conversationProtocol: 1, decisionProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development', token: 'a'.repeat(64),
      instructions: 'Follow the user goal.', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite: false, commandExecution: false } } });
  const decide = (action: string) => client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'record_decision', arguments: {
    action, reason: 'Verified the current progress.', progress: 'One step checked.', nextAction: action === 'continue' ? 'Check the remaining result.' : '',
    criteria: [{ criterion: 'Verify the requested result.', met: action === 'complete', evidence: action === 'complete' ? 'Observed the expected result.' : '' }],
  } });
  return { agent, client, store, decide, directory };
}

test('room corrections queued during execution take priority over completion and survive restart', async () => {
  let f = goalSetup();
  const finish = createDeferred<void>();
  f.client.onStart = async () => { await finish.promise; await f.decide('complete'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.submit('goal', 'Verify the requested result.', { roomId: 'room', conversation: 'goal', goal: true });
  await f.client.started.promise;
  f.agent.input('goal', 'correction', 'Use server sessions instead.', 'room');
  f.agent.input('goal', 'correction', 'Use server sessions instead.', 'room');
  expect(f.store.task('goal')?.inputs).toEqual([{ id: 'correction', prompt: 'Use server sessions instead.', pending: true }]);
  expect(() => f.agent.input('goal', 'correction', 'Different instruction', 'room')).toThrow('identity');
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  finish.resolve(); await f.agent.settled();
  expect(f.store.task('goal')).toMatchObject({ status: 'waiting', goal: { phase: 'ready', pending: null } });
  f = goalSetup(f.directory);
  f.client.onStart = async () => { await f.decide('blocked'); f.client.complete(); return { turn: { id: 'turn' } }; };
  f.agent.pump(); await f.agent.settled();
  const input = f.client.calls.find(c => c.method === 'turn/start')!.params.input as { text: string }[];
  expect(input[0]!.text).toContain('Use server sessions instead.');
  expect(input[0]!.text).toContain('what already ran');
  expect(f.store.task('goal')?.inputs).toEqual([{ id: 'correction', prompt: 'Use server sessions instead.' }]);
  f.agent.pump(); await f.agent.settled();
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('stopping a turn does not silently execute a queued correction', async () => {
  const f = goalSetup(), finish = createDeferred<void>();
  f.client.onStart = async () => { await finish.promise; f.client.complete('interrupted'); return { turn: { id: 'turn' } }; };
  f.agent.submit('goal', 'Verify the requested result.', { roomId: 'room', conversation: 'goal', goal: true });
  await f.client.started.promise;
  f.agent.input('goal', 'correction', 'Change direction', 'room');
  finish.resolve(); await f.agent.settled();
  f.agent.pump(); await f.agent.settled();
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  expect(f.store.task('goal')?.inputs?.[0]?.pending).toBe(true);
});
