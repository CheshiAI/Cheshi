import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistAgent } from './agent';
import { FakeClient } from './agent-test-client';
import { AgentStore } from './store';
import { WorkerCustomToolQueue } from './custom-tool-queue';
import type { CustomTool } from './custom-tool-contract';
import { record, type JsonRecord } from './protocol';

const tool: CustomTool = { name: 'echo', description: 'Echo input', enabled: true, runtime: 'bun', script: 'scripts/echo.ts',
  parameters: [{ name: 'text', type: 'string', description: 'Text to echo', required: true }] };
test('custom tools register with Codex and return relay results to the active task; permissions and disabled tools are enforced', async () => {
  for (const commandExecution of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), 'worker-custom-tools-'));
    const client = new FakeClient(), queue = new WorkerCustomToolQueue(), store = new AgentStore(directory);
    const configuration = { profileId: 'test', accountId: 'default', role: 'custom', token: 'a'.repeat(64), instructions: 'Test',
      model: null, reasoningEffort: null, serviceTier: null, customTools: [tool, { ...tool, name: 'disabled', enabled: false }], permissions: { fileWrite: false, commandExecution } };
    const agent = new SpecialistAgent({ client, store, profile: 'Test', workspace: directory, configuration, customTools: queue });
    let called = false;
    client.onStart = async () => {
      let response: unknown, failure: unknown;
      const operation = client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'homie_echo', arguments: { text: 'Hello' } });
      const request = queue.exchange({ protocol: 1, results: [] }).requests[0];
      if (commandExecution) {
        expect(request?.tool).toBe('homie_echo'); expect(request?.args).toEqual({ text: 'Hello' });
        queue.exchange({ protocol: 1, results: [{ id: request!.id, result: { result: 'Hello' } }] });
      } else expect(request).toBeUndefined();
      try { response = await operation; } catch (error) { failure = error; }
      if (commandExecution) expect(response).toEqual({ result: 'Hello' }); else expect((failure as Error).message).toContain('command permission');
      try { await client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'homie_disabled', arguments: { text: 'Hello' } }); throw new Error('Unexpected success'); }
      catch (error) { expect((error as Error).message).toContain('disabled'); }
      called = true; client.complete(); return { turn: { id: 'turn' } };
    };
    try {
      agent.submit('test', 'Use echo.', { roomId: 'room', conversation: 'test', goal: false }); await agent.settled();
      const start = client.calls.find(call => call.method === 'thread/start')!;
      expect(start.params.dynamicTools).toMatchObject([{ name: 'homie_echo' }]); expect(called).toBe(true);
      expect(store.task('test')?.status).toBe('completed');
    } finally { agent.disposeScratch(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('a room conversation registers custom and built-in tools using one canonical native format', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-custom-catalog-'));
  class CanonicalClient extends FakeClient {
    override async request(method: string, params: JsonRecord): Promise<JsonRecord> {
      if (method === 'thread/start') {
        const definitions = params.dynamicTools as JsonRecord[];
        expect(definitions.some(definition => definition.name === 'homie_echo')).toBe(true);
        expect(definitions.some(definition => definition.name !== 'homie_echo')).toBe(true);
        for (const definition of definitions) {
          expect(definition.type).toBe('function');
          expect(typeof definition.name).toBe('string');
          expect(typeof definition.description).toBe('string');
          expect(record(definition.inputSchema).type).toBe('object');
        }
      }
      return super.request(method, params);
    }
  }
  const client = new CanonicalClient();
  const agent = new SpecialistAgent({ client, store: new AgentStore(directory), profile: 'Test', workspace: directory,
    customTools: new WorkerCustomToolQueue(), configuration: {
      profileId: 'test', accountId: 'default', role: 'custom', token: 'a'.repeat(64), instructions: 'Test',
      model: null, reasoningEffort: null, serviceTier: null, customTools: [tool], conversationProtocol: 1,
      permissions: { fileWrite: false, commandExecution: true },
    } });
  try {
    agent.submit('test', 'Use echo.', { roomId: 'room', conversation: 'test', goal: false, automatic: true, userText: 'Use echo.' });
    await agent.settled();
    expect(client.calls.some(call => call.method === 'turn/start')).toBe(true);
  } finally { agent.disposeScratch(); await rm(directory, { recursive: true, force: true }); }
});
