import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentCodeGraph } from '../lib/agent-orchestration/codegraph-source.mts';
import { AgentCodeGraphRelay } from '../lib/agent-orchestration/codegraph-relay.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { WorkerCodeGraphQueue } from '../../experiments/codex-specialists/src/codegraph-queue.ts';
import { codegraphArguments, codegraphTools } from '../../experiments/codex-specialists/src/codegraph-tools.ts';
import { tools as sessionTools } from '../../codegraph/src/mcp/tool-definitions.ts';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol.ts';
import { SpecialistAgent } from '../../experiments/codex-specialists/src/agent.ts';
import { AgentStore } from '../../experiments/codex-specialists/src/store.ts';
import { FakeClient } from '../../experiments/codex-specialists/src/agent-test-client.ts';

const directories: string[] = [];
function temporary() { const p = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-codegraph-relay-'))); directories.push(p); return p; }
afterEach(() => { for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
const ok = { content: [{ type: 'text', text: 'symbol /workspace/src/main.ts:1; index may be stale' }] };
async function rejected(operation: Promise<unknown>, message: string) {
  let error: unknown; try { await operation; } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
test('CodeGraph tools reject foreign roots, traversal, writers and malformed arguments', () => {
  for (const file of ['/etc/passwd', '../private', '/workspace/../private', 'C:\\private', 'a/../b']) {
    expect(() => codegraphArguments('codegraph_node', { file })).toThrow('assigned project');
  }
  expect(() => codegraphArguments('codegraph_explore', { query: 'x', projectPath: '/outside' })).toThrow();
  expect(() => codegraphArguments('codegraph_index', {})).toThrow();
  expect(() => codegraphArguments('codegraph_node', { file: 'a', includeCode: 'true' })).toThrow();
  expect(() => codegraphArguments('codegraph_node', {})).toThrow();
  expect(() => codegraphArguments('codegraph_explore', { query: 'x', maxFiles: '100' })).toThrow();
  expect(codegraphArguments('codegraph_node', { file: '/workspace/src/a.ts', includeCode: true })).toEqual({ file: 'src/a.ts', includeCode: true });
});
test('Homie query schemas match SESSION arguments without extra size or range restrictions', () => {
  const properties = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'projectPath').map(([key, raw]) => {
      const { description: _description, ...schema } = raw as Record<string, unknown>;
      return [key, schema];
    }));
  for (const tool of codegraphTools) {
    const session = sessionTools.find(t => t.name === tool.name)!;
    expect(properties(tool.inputSchema.properties)).toEqual(properties(session.inputSchema.properties));
    expect(tool.inputSchema.required).toEqual(session.inputSchema.required ?? []);
  }
  for (const [tool, args] of [
    ['codegraph_node', { file: 'large.ts', limit: 180, offset: 1_000_001, line: 240, symbolsOnly: false }],
    ['codegraph_explore', { query: 'symbol\n'.repeat(1000), maxFiles: 30 }],
    ['codegraph_search', { query: 'Symbol', kind: 'class', limit: 500 }],
    ['codegraph_callers', { symbol: 'Symbol', limit: 300 }],
    ['codegraph_callees', { symbol: 'Symbol', limit: 300 }],
    ['codegraph_impact', { symbol: 'Symbol', depth: 5 }],
  ] as const) expect(codegraphArguments(tool, args)).toEqual(args);
});
test('worker queue supports bounded concurrent queries and releases canceled requests', async () => {
  const queue = new WorkerCodeGraphQueue(), controller = new AbortController();
  const calls = Array.from({ length: 4 }, () => queue.call('codegraph_search', { query: 'x' }, controller.signal));
  expect(queue.pending).toBe(true);
  await rejected(queue.call('codegraph_search', { query: 'x' }, controller.signal), 'Too many');
  controller.abort();
  for (const call of calls) expect(await call).toMatchObject({ isError: true });
  expect(queue.pending).toBe(false);
  expect(queue.exchange({ protocol: 1, results: [] }).requests).toHaveLength(0);
});
test('relay uses the registered project, deduplicates polling and delivers results without shell permissions', async () => {
  const queue = new WorkerCodeGraphQueue(), controller = new AbortController(), complete = createDeferred<void>();
  const binding = bindingFor('/project', 'docker:test', 'agent', 'account');
  let calls = 0;
  const relay = new AgentCodeGraphRelay(async (workspace, tool, args) => {
    calls++; expect(workspace).toBe('/project'); expect(tool).toBe('codegraph_explore'); expect(args).toEqual({ query: 'find function' }); return ok;
  }, () => complete.resolve(), async (_connection, body) => queue.exchange(body));
  const connection = { endpoint: 'http://127.0.0.1:1234', token: 'fixture' };
  try {
    const result = queue.call('codegraph_explore', { query: 'find function' }, controller.signal);
    await Promise.all([relay.tick(binding, connection, () => true), relay.tick(binding, connection, () => true)]);
    await complete.promise;
    await relay.tick(binding, connection, () => true);
    expect(await result).toEqual(ok); expect(calls).toBe(1);
  } finally { controller.abort(); await relay.dispose(); }
});
test('changed assignment suppresses a query result and query failure reaches the worker', async () => {
  for (const failure of [false, true]) {
    const queue = new WorkerCodeGraphQueue(), controller = new AbortController(), query = createDeferred<unknown>(), complete = createDeferred<void>();
    let valid = true;
    const binding = bindingFor('/project', 'docker:test', 'agent', 'account');
    const relay = new AgentCodeGraphRelay(() => query.promise, () => complete.resolve(), async (_connection, body) => queue.exchange(body));
    const connection = { endpoint: 'http://127.0.0.1:1234', token: 'fixture' };
    try {
      const result = queue.call('codegraph_search', { query: 'x' }, controller.signal);
      await relay.tick(binding, connection, () => valid);
      if (failure) query.reject(new Error('unavailable')); else { valid = false; query.resolve(ok); }
      await complete.promise;
      valid = true; await relay.tick(binding, connection, () => valid);
      expect(await result).toMatchObject({ isError: true });
    } finally { controller.abort(); await relay.dispose(); }
  }
});
test('host MCP connection pins the project and central read-only index and translates result paths', async () => {
  const root = temporary(), script = join(root, 'mcp.cjs');
  writeFileSync(script, `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line', line=>{const m=JSON.parse(line);
if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
if(m.method==='tools/call') console.log(JSON.stringify({id:m.id,result:{content:[{type:'text',text:JSON.stringify({args:m.params.arguments,readonly:process.env.CODEGRAPH_MCP_READ_ONLY,root:process.env.CODEGRAPH_DATA_ROOT,cwd:process.cwd()})}]}}));
});`);
  const query = createAgentCodeGraph({ cli: { executable: process.execPath, args: [script] }, dataRoot: root });
  const result = await query(root, 'codegraph_node', { file: '/workspace/a.ts' }, new AbortController().signal) as { content: { text: string }[] };
  expect(JSON.parse(result.content[0]!.text)).toEqual({ args: { file: 'a.ts', projectPath: '/workspace' }, readonly: '1', root: '/workspace', cwd: '/workspace' });
  await rejected(query(root, 'codegraph_node', { file: '../outside' }, new AbortController().signal), 'assigned project');
});
test('MCP launch failure and cancellation return explicit errors', async () => {
  const root = temporary();
  const query = createAgentCodeGraph({ cli: { executable: join(root, 'missing'), args: [] }, dataRoot: root });
  expect(await query(root, 'codegraph_search', { query: 'x' }, new AbortController().signal)).toMatchObject({ isError: true });
  const controller = new AbortController(); controller.abort();
  await rejected(query(root, 'codegraph_search', { query: 'x' }, controller.signal), 'abort');
});
test('large CodeGraph results reach the worker without a Homie-only response cutoff', async () => {
  const root = temporary(), script = join(root, 'large-mcp.cjs');
  writeFileSync(script, `require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
if(m.method==='tools/call')console.log(JSON.stringify({id:m.id,result:{content:[{type:'text',text:'x'.repeat(600000)}]}}));});`);
  const query = createAgentCodeGraph({ cli: { executable: process.execPath, args: [script] }, dataRoot: root });
  const result = await query(root, 'codegraph_node', { file: 'large.ts', limit: 180 }, new AbortController().signal);
  const queue = new WorkerCodeGraphQueue(), pending = queue.call('codegraph_node', { file: 'large.ts', limit: 180 }, new AbortController().signal);
  const request = queue.exchange({ protocol: 1, results: [] }).requests[0]!;
  queue.exchange({ protocol: 1, results: [{ id: request.id, result }] });
  expect(await pending).toEqual({ isError: false, content: [{ type: 'text', text: 'x'.repeat(600000) }] });
});
test('read-only worker exposes CodeGraph during intake and routes the real dynamic tool call', async () => {
  const root = temporary(), store = new AgentStore(root), client = new FakeClient(), queue = new WorkerCodeGraphQueue();
  let complete = false;
  queue.subscribe(() => { if (!queue.pending) return; const exchange = queue.exchange({ protocol: 1, results: [] }); queue.exchange({ protocol: 1, results: exchange.requests.map(r => ({ id: r.id, result: ok })) }); });
  const agent = new SpecialistAgent({ client, store, workspace: root, profile: 'Read project', codegraph: queue,
    configuration: { codegraphProtocol: 1, conversationProtocol: 1, decisionProtocol: 1, profileId: 'dev', role: 'development', accountId: 'fixture', token: 'a'.repeat(64), instructions: 'Read project', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite: false, commandExecution: false } } });
  client.onStart = async () => {
    const result = await client.toolHandler!({ threadId: 'thread', turnId: 'turn', tool: 'codegraph_explore', arguments: { query: 'x' } });
    expect(result).toEqual(ok); complete = true; client.complete(); return { turn: { id: 'turn' } };
  };
  agent.submit('task', 'Understand code', { roomId: 'room', conversation: 'conversation', goal: false, automatic: true, userText: 'Understand code' });
  await agent.settled(); expect(complete).toBe(true);
  const start = client.calls.find(c => c.method === 'thread/start')!;
  expect(start.params.dynamicTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'codegraph_explore' })]));
  expect(start.params.config).toMatchObject({ 'features.shell_tool': false, 'features.unified_exec': false });
});

test('cold resumes retain recorded CodeGraph capability and old conversations receive an explicit limitation', async () => {
  for (const recorded of [false, true]) {
    const root = temporary(), store = new AgentStore(root), client = new FakeClient(), queue = new WorkerCodeGraphQueue();
    store.create('previous', 'Previous task', { conversation: 'conversation' });
    store.update('previous', { threadId: 'thread', status: 'completed', ...(recorded ? { codegraphTools: true as const } : {}) });
    store.saveThread('thread', null, 'conversation');
    const reopened = new AgentStore(root);
    const agent = new SpecialistAgent({ client, store: reopened, workspace: root, profile: 'Read project', codegraph: queue });
    agent.submit('next', 'Continue', { roomId: 'room', conversation: 'conversation', goal: false });
    await agent.settled();
    const resume = client.calls.find(c => c.method === 'thread/resume')!;
    expect(resume.params.dynamicTools).toBeUndefined();
    expect(String(resume.params.developerInstructions)).toContain(recorded ? 'Use codegraph_explore' : 'older conversation has no CodeGraph tools');
    expect(reopened.task('next')?.codegraphTools).toBe(recorded ? true : undefined);
  }
});
