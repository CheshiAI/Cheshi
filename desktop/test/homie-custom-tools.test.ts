import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentPackage } from '../shared/agent-package';
import { officialAgentPackages, readAgentPackage } from '../lib/agent-management/packages.mts';
import { writeHomiePack } from '../lib/agent-management/homie-packs.mts';
import { customToolArguments, customToolDefinition, parseCustomTools } from '../../experiments/codex-specialists/src/custom-tool-contract';
import { externalToolFixture } from './homie-tool-fixture';
import { executeCustomTool, publicIPv4 } from '../lib/agent-management/custom-tool-execution.mts';
import { createToolCredentials } from '../lib/agent-management/tool-credentials.mts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';
import { WorkerCustomToolQueue } from '../../experiments/codex-specialists/src/custom-tool-queue';
import { AgentCustomToolRelay } from '../lib/agent-orchestration/custom-tool-relay.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol';

async function examplePack() {
  const pack = (await officialAgentPackages())[0]!;
  const { tool, resources } = externalToolFixture;
  return parseAgentPackage({ ...pack, tools: [tool], resources });
}
async function fails(operation: Promise<unknown>, message: string) {
  let failure: unknown; try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain(message);
}
test('tool schemas and scripts survive pack export/import; invalid schemas and secret fields are rejected', async () => {
  const pack = await examplePack(), tool = pack.tools![0]!;
  const directory = await mkdtemp(join(tmpdir(), 'homie-tool-contract-'));
  try {
    const path = join(directory, 'tool.homiepack.json'); await writeHomiePack(path, pack);
    expect(await readAgentPackage(path)).toEqual(pack);
    expect(customToolDefinition(tool).name).toBe('homie_external_judge');
    expect(customToolArguments(tool, { content: '2+2=4', criteria: 'Correct?' })).toEqual({ content: '2+2=4', criteria: 'Correct?' });
    for (const input of [{ content: 2, criteria: 'yes' }, { content: 'x' }, { content: 'x', criteria: 'y', secret: 'z' }]) expect(() => customToolArguments(tool, input)).toThrow();
    for (const url of ['http://example.com', 'https://127.0.0.1', 'https://host.local', 'https://user:key@example.com', 'https://example.com?token=key']) {
      expect(() => parseCustomTools([{ ...tool, network: { url, credential: null } }])).toThrow();
    }
    expect(() => parseCustomTools([{ ...tool, enabled: 'true' }])).toThrow();
    expect(() => parseCustomTools([{ ...tool, network: { ...tool.network, apiKey: 'secret' } }])).toThrow();
    expect(() => parseCustomTools([tool, tool])).toThrow();
    expect(() => parseAgentPackage({ ...pack, resources: { programs: [], files: [] } })).toThrow();
    expect(() => parseAgentPackage({ ...pack, tools: [{ ...tool, runtime: 'python3' }] })).toThrow();
    for (const address of ['127.0.0.1','10.1.1.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.1.1','0.0.0.0','224.0.0.1']) expect(publicIPv4(address)).toBe(false);
    expect(publicIPv4('1.1.1.1')).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('API credentials are encrypted and scoped to the endpoint origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homie-tool-credentials-'));
  const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from([...text].reverse().join('')), decryptString: (bytes: Buffer) => [...bytes.toString()].reverse().join('') };
  try {
    const store = createToolCredentials(directory, encryption);
    await store.save('https://api.example.com', 'external', 'fixture-secret');
    expect(await store.get('https://api.example.com', 'external')).toBe('fixture-secret');
    expect(await store.get('https://example.com', 'external')).toBeNull();
    expect(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8')).not.toContain('fixture-secret');
    encryption.isEncryptionAvailable = () => false;
    await fails(store.save('https://api.example.com', 'external', 'another'), 'Secure');
    encryption.isEncryptionAvailable = () => true;
    expect(await store.remove('https://api.example.com', 'external')).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('runner isolates scripts, injects no secrets and brokers only the declared endpoint', async () => {
  const pack = await examplePack(), tool = pack.tools![0]!;
  const calls: { args: string[]; input?: string }[] = [];
  let valid = true, output = JSON.stringify({ request: { body: { content: 'synthetic' } } }), status = '0', posts = 0;
  const run: DockerCommand = async (args, input) => { calls.push({ args, input }); return args.includes('start') ? output : args.includes('inspect') ? status : ''; };
  const options = { run, prefix: ['--context','fixture'], image: 'sha256:fixture', tool, args: { content: 'synthetic', criteria: 'yes' }, signal: new AbortController().signal,
    valid: () => valid, credential: async () => 'fixture-secret', post: async (url: URL, _body: unknown, secret: string | null) => {
      posts++; expect(url.href).toBe(tool.network!.url); expect(secret).toBe('fixture-secret'); return { answer: true };
    } };
  expect(await executeCustomTool(options)).toEqual({ answer: true });
  expect(calls[0]!.args).toContain('--read-only'); expect(calls[0]!.args).toContain('none');
  expect(calls[0]!.args).not.toContain('--mount'); expect(calls[0]!.args).not.toContain('--env');
  expect(JSON.stringify(calls)).not.toContain('fixture-secret'); expect(calls.at(-1)!.args).toContain('rm');
  output = 'not json'; await fails(executeCustomTool(options), 'JSON');
  status = '1'; await fails(executeCustomTool(options), 'unsuccessfully'); status = '0';
  output = JSON.stringify({ request: { body: {} } });
  await fails(executeCustomTool({ ...options, credential: async () => null }), 'API key');
  valid = false; await fails(executeCustomTool(options), 'changed'); expect(posts).toBe(1);
  valid = true; output = JSON.stringify({ result: ['local', 3] }); expect(await executeCustomTool(options)).toEqual(['local',3]);
});
test('relay delivers once, cancels removed requests, and persists completed receipts across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homie-tool-relay-'));
  const queue = new WorkerCustomToolQueue();
  const binding = bindingFor('/project', 'docker:fixture', 'agent', 'default');
  const connection = { endpoint: 'http://127.0.0.1:1234', token: 'fixture' };
  const transport = async (_connection: unknown, body: unknown) => queue.exchange(body);
  let count = 0, notices = 0;
  const called = createDeferred<void>();
  let relay = new AgentCustomToolRelay(async () => { count++; called.resolve(); return { result: 'done' }; }, () => { notices++; }, transport, join(directory, 'receipts.json'));
  const controller = new AbortController();
  const result = queue.call('homie_test', {}, controller.signal);
  try {
    await relay.tick(binding, connection, () => true); await called.promise;
    await Promise.resolve(); expect(notices).toBeGreaterThan(0);
    await relay.dispose();
    relay = new AgentCustomToolRelay(async () => { count++; return {}; }, () => {}, transport, join(directory, 'receipts.json'));
    await relay.tick(binding, connection, () => true); await relay.tick(binding, connection, () => true);
    expect(await result).toEqual({ result: 'done' }); expect(count).toBe(1);
    const pending = queue.call('homie_test', {}, controller.signal); controller.abort();
    expect(await pending).toMatchObject({ isError: true }); expect(queue.pending).toBe(false);
  } finally { controller.abort(); await relay.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('canceling an isolated script cleans up its container and never posts a request', async () => {
  const tool = (await examplePack()).tools![0]!, controller = new AbortController();
  const started = createDeferred<void>(), completion = createDeferred<string>();
  let removed = false, posted = false;
  const run: DockerCommand = async args => {
    if (args.includes('start')) { started.resolve(); return completion.promise; }
    if (args.includes('rm')) { removed = true; completion.resolve(JSON.stringify({ request: { body: {} } })); }
    return '';
  };
  const operation = executeCustomTool({ run, prefix: [], image: 'fixture', tool, args: { content: 'x', criteria: 'y' }, signal: controller.signal,
    post: async () => { posted = true; return {}; } });
  await started.promise; controller.abort();
  let rejected = false; try { await operation; } catch { rejected = true; }
  expect(rejected).toBe(true); expect(removed).toBe(true); expect(posted).toBe(false);
});
