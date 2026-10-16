import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, realpath, writeFile, mkdir, chmod, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { HostToolRegistration } from '../lib/agent-management/host-tool-registration.mts';
import { executeHostProcess } from '../lib/agent-management/host-tool-execution.mts';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import { parseAgentPackage } from '../shared/agent-package';
import type { SpecialistAgent } from '../shared/agent-registry';
import { parseCustomTools } from '../../experiments/codex-specialists/src/custom-tool-contract';
import { imageDigest, receiveHostToolResult, toolResponseContent, validateHostPng, readHostExchange, HOST_EXCHANGE_BYTES } from '../../experiments/codex-specialists/src/host-tool-artifacts';
import { deflateSync } from 'node:zlib';
import { WorkerCustomToolQueue } from '../../experiments/codex-specialists/src/custom-tool-queue';
import { AppServerClient } from '../../experiments/codex-specialists/src/app-server-client';
import { AgentCustomToolRelay } from '../lib/agent-orchestration/custom-tool-relay.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol';
import { HostToolPolicies } from '../lib/agent-management/host-tool-policy.mts';
import { parseHostToolRequest } from '../shared/host-tools';

async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
function png() {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length); body.copy(out, 4);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(script = 'console.log(JSON.stringify({result:JSON.parse(await Bun.stdin.text())}));') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'host-tool-test-')));
  const tool = parseCustomTools([{ name: 'fixture', description: 'Local fixture', enabled: true, execution: 'host', runtime: 'bun', script: 'scripts/run.ts',
    parameters: [{ name: 'text', type: 'string', description: 'Text', required: true }] }])[0]!;
  const pack = parseAgentPackage({ ...(await officialAgentPackages())[0], tools: [tool], resources: { programs: [], files: [
    { path: 'scripts/run.ts', content: script }, { path: 'scripts/dependency.ts', content: 'export const value = 1;' },
  ] } });
  const agent: SpecialistAgent = { id: 'fixture', revision: 1, createdAt: '', updatedAt: '', name: 'fixture', role: 'custom', instructions: 'Fixture',
    accountId: 'account-a', permissions: { fileWrite: false, commandExecution: true }, model: null, reasoningEffort: null, serviceTier: null,
    assignments: [{ workspaceRoot: directory, instructions: '' }], package: pack };
  const service = new HostToolRegistration(join(directory, 'state'), (_workspace, id) => id === agent.id ? agent : undefined);
  const scope = { workspace: directory, agentId: agent.id, accountId: agent.accountId! };
  const request = { action: 'allow' as const, agentId: agent.id, tool: tool.name };
  const allow = () => service.request(directory, request, { selectExecutable: async () => process.execPath, confirm: async review => {
    expect(review.files).toContain('scripts/dependency.ts'); expect(review.accountId).toBe(agent.accountId!); return true;
  } });
  const execute = (signal = new AbortController().signal) => service.execute(scope, tool, { text: 'fixture' }, signal, () => true);
  return { directory, agent, service, tool, scope, request, allow, execute, close: async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

async function automatic(f: Awaited<ReturnType<typeof fixture>>, autoApprove?: boolean) {
  return f.service.request(f.directory, { action: 'policy', agentId: f.agent.id, tool: f.tool.name,
    ...(autoApprove === undefined ? {} : { autoApprove }) });
}

test('automatic approval defaults off, persists locally and stays scoped to project, Homie and account', async () => {
  const f = await fixture();
  try {
    expect((await automatic(f)).autoApprove).toBe(false);
    expect((await automatic(f, true)).autoApprove).toBe(true);
    const restarted = new HostToolPolicies(join(f.directory, 'state'));
    expect(restarted.read(f.scope).enabled).toBe(true);
    for (const scope of [{ ...f.scope, workspace: f.directory + '/other' }, { ...f.scope, agentId: 'other' }, { ...f.scope, accountId: 'other' }]) {
      expect(restarted.read(scope).enabled).toBe(false);
    }
    const next = new HostToolRegistration(join(f.directory, 'state'), () => f.agent);
    expect((await next.request(f.directory, { ...f.request, action: 'policy' })).autoApprove).toBe(true);
    next.dispose();
    expect(JSON.stringify(f.agent)).not.toContain('autoApprove');
    expect(JSON.stringify(f.agent)).not.toContain('autoPolicyRevision');
    for (const autoApprove of ['true', 1, null, undefined]) {
      expect(() => parseHostToolRequest({ ...f.request, action: 'policy', autoApprove })).toThrow();
    }
    expect(() => parseHostToolRequest({ ...f.request, autoApprove: true })).toThrow();
  } finally { await f.close(); }
});

test('automatic approval selects a runtime once, skips confirmation and renews updated bundles without UI', async () => {
  const f = await fixture();
  let selections = 0, confirmations = 0;
  const ui = { selectExecutable: async () => { selections++; return process.execPath; }, confirm: async () => { confirmations++; return false; } };
  try {
    await automatic(f, true);
    await fails(f.execute(), 'Allow'); // No automatic runtime discovery or selection.
    expect((await f.service.request(f.directory, f.request, ui)).allowed).toBe(true);
    expect((await f.service.request(f.directory, f.request, ui)).allowed).toBe(true);
    expect(selections).toBe(1); expect(confirmations).toBe(0);
    f.agent.package!.resources!.files[1]!.content += '\n// updated dependency';
    f.agent.revision++;
    expect((await f.execute()).data).toEqual({ text: 'fixture' });
    expect((await f.service.request(f.directory, { ...f.request, action: 'status' })).allowed).toBe(true);
    f.agent.permissions.commandExecution = false;
    await fails(f.execute(), 'Allow'); f.agent.permissions.commandExecution = true;
    await f.service.request(f.directory, { ...f.request, action: 'revoke' });
    await fails(f.execute(), 'Allow');
    expect((await automatic(f)).autoApprove).toBe(true);
  } finally { await f.close(); }
});

test('turning automatic approval off cancels automatic calls and restores explicit confirmation', async () => {
  const f = await fixture('await Bun.sleep(10_000); console.log(JSON.stringify({result:true}));');
  try {
    await automatic(f, true); await f.allow();
    const pending = fails(f.execute(), 'canceled');
    await Bun.sleep(150);
    expect((await automatic(f, false)).allowed).toBe(false);
    await pending;
    await fails(f.execute(), 'Allow');
    let confirmed = false;
    const result = await f.service.request(f.directory, f.request, { selectExecutable: async () => process.execPath,
      confirm: async () => { confirmed = true; return false; } });
    expect(confirmed).toBe(true); expect(result.allowed).toBe(false);
  } finally { await f.close(); }
});

test('policy changes while selecting a runtime cannot create an automatic grant', async () => {
  const f = await fixture();
  try {
    await automatic(f, true);
    await fails(f.service.request(f.directory, f.request, { selectExecutable: async () => {
      await automatic(f, false); return process.execPath;
    }, confirm: async () => true }), 'changed during review');
    await fails(f.execute(), 'Allow');
  } finally { await f.close(); }
});

test('status does not report a stale automatic grant when the policy changes during executable verification', async () => {
  const f = await fixture();
  try {
    await automatic(f, true); await f.allow();
    const status = f.service.request(f.directory, { ...f.request, action: 'status' });
    await automatic(f, false);
    expect((await status).allowed).toBe(false);
  } finally { await f.close(); }
});

test('automatic approval never trusts a changed executable or a different runtime', async () => {
  const f = await fixture();
  try {
    await automatic(f, true);
    const executable = join(f.directory, 'runtime');
    await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700);
    await f.service.request(f.directory, f.request, { selectExecutable: async () => executable, confirm: async () => false });
    await writeFile(executable, '#!/bin/sh\nexit 1\n');
    f.agent.package!.resources!.files[1]!.content += '\n// updated';
    await fails(f.execute(), 'Allow');
    let selections = 0;
    await f.service.request(f.directory, f.request, { selectExecutable: async () => { selections++; return process.execPath; }, confirm: async () => false });
    const nextTool = { ...f.tool, runtime: 'node' as const };
    f.agent.package!.tools![0] = nextTool;
    await fails(f.service.execute(f.scope, nextTool, { text: 'fixture' }, new AbortController().signal, () => true), 'Allow');
    expect(selections).toBe(1);
  } finally { await f.close(); }
});

test('local host approval is separate, scoped, content-bound and never exported', async () => {
  const f = await fixture();
  try {
    await fails(f.execute(), 'Allow');
    const declined = await f.service.request(f.directory, f.request, { selectExecutable: async () => process.execPath, confirm: async () => false });
    expect(declined.allowed).toBe(false);
    expect((await f.allow()).allowed).toBe(true);
    expect(await f.execute()).toEqual({ hostToolProtocol: 1, data: { text: 'fixture' }, images: [] });
    expect(JSON.stringify(f.agent.package)).not.toContain(process.execPath);
    await fails(f.service.execute({ ...f.scope, accountId: 'other' }, f.tool, {}, new AbortController().signal, () => true), 'Allow');
    await fails(f.service.execute({ ...f.scope, workspace: tmpdir() }, f.tool, {}, new AbortController().signal, () => true), 'Save and assign');
    f.agent.permissions.commandExecution = false; await fails(f.execute(), 'Allow'); f.agent.permissions.commandExecution = true;
    f.agent.package!.resources!.files[1]!.content += '\n// changed dependency';
    await fails(f.execute(), 'Allow');
    expect((await f.service.request(f.directory, { ...f.request, action: 'status' })).allowed).toBe(false);
    await f.allow();
    expect((await f.service.request(f.directory, { ...f.request, action: 'revoke' })).allowed).toBe(false);
    await fails(f.execute(), 'Allow');
  } finally { await f.close(); }
});

test('review races do not grant changed bundles; manifest flags never grant access', async () => {
  const f = await fixture();
  try {
    await fails(f.service.request(f.directory, f.request, { selectExecutable: async () => process.execPath, confirm: async () => {
      f.agent.revision++; return true;
    } }), 'changed during review');
    await fails(f.execute(), 'Allow');
    expect(() => parseCustomTools([{ ...f.tool, execution: 'shell' }])).toThrow();
    expect(() => parseCustomTools([{ ...f.tool, network: { url: 'https://example.com', credential: null } }])).toThrow();
    expect(() => parseCustomTools([{ ...f.tool, executable: '/bin/sh' }])).toThrow();
  } finally { await f.close(); }
});

test('a modified local executable invalidates approval before execution', async () => {
  const f = await fixture();
  try {
    const executable = join(f.directory, 'runtime');
    await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700);
    expect((await f.service.request(f.directory, f.request, { selectExecutable: async () => executable, confirm: async () => true })).allowed).toBe(true);
    await writeFile(executable, '#!/bin/sh\nexit 1\n');
    await fails(f.execute(), 'executable or permission changed');
    expect((await f.service.request(f.directory, { ...f.request, action: 'status' })).allowed).toBe(false);
  } finally { await f.close(); }
});

test('revocation cancels a running process without replay; modified assignment denies further calls', async () => {
  const f = await fixture('await Bun.sleep(10_000); console.log(JSON.stringify({result:true}));');
  try {
    await f.allow();
    const pending = fails(f.execute(), 'canceled');
    await Bun.sleep(150);
    await f.service.request(f.directory, { ...f.request, action: 'revoke' });
    await pending;
    await f.allow();
    const changed = fails(f.execute(), 'permission changed');
    await Bun.sleep(150); f.agent.revision++;
    await changed;
  } finally { await f.close(); }
});

test('host execution validates output, handles timeout and cancellation, and strips inherited secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-process-test-'));
  const script = join(directory, 'run.ts'), output = join(directory, 'output'); await mkdir(output);
  const options = { executable: process.execPath, script, cwd: directory, output, cache: directory, args: {}, signal: new AbortController().signal, valid: () => true };
  try {
    await writeFile(script, 'console.log(JSON.stringify({result:{keys:Object.keys(process.env),args:process.argv.slice(2)}}));');
    const result = await executeHostProcess(options);
    expect(result.data).toMatchObject({ args: [] });
    expect((result.data as { keys: string[] }).keys).not.toContain('CODEX_HOME');
    await writeFile(script, 'console.log("bad json");'); await fails(executeHostProcess(options), 'JSON');
    await writeFile(script, 'await Bun.sleep(10000);'); await fails(executeHostProcess({ ...options, timeoutMs: 50 }), 'timed out');
    const controller = new AbortController(); controller.abort();
    await fails(executeHostProcess({ ...options, signal: controller.signal }), 'abort');
    await writeFile(script, 'console.log(JSON.stringify({result:true,images:["../outside.png"]}));'); await fails(executeHostProcess(options), 'filename');
    await writeFile(join(directory, 'outside.png'), png());
    await createSymbolicLink(join(directory, 'outside.png'), join(output, 'link.png'));
    await writeFile(script, 'console.log(JSON.stringify({result:true,images:["link.png"]}));'); await fails(executeHostProcess(options), 'outside');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('PNG evidence reaches worker storage and actual app-server image content, with hash and format checks', async () => {
  const bytes = png(), envelope = { hostToolProtocol: 1, data: { observation: { windowId: 9 } }, images: [{ name: 'screen.png', base64: bytes.toString('base64'), sha256: imageDigest(bytes) }] };
  const output = await receiveHostToolResult(envelope, new AbortController().signal);
  const artifacts = output.artifacts as { path: string; sha256: string }[];
  try {
    expect(await readFile(artifacts[0]!.path)).toEqual(bytes);
    expect(toolResponseContent(output)).toEqual([{ type: 'inputText', text: JSON.stringify(output) }, { type: 'inputImage', imageUrl: `data:image/png;base64,${bytes.toString('base64')}` }]);
    expect(toolResponseContent({ result: 'old tool' })).toEqual([{ type: 'inputText', text: '{"result":"old tool"}' }]);
    expect(validateHostPng(bytes)).toEqual({ width: 1, height: 1 });
    const damaged = Buffer.from(bytes); damaged[damaged.length - 1]! ^= 1;
    expect(() => validateHostPng(damaged)).toThrow('checksum');
    for (const image of [{ ...envelope.images[0], sha256: 'wrong' }, { ...envelope.images[0], name: '../screen.png' },
      { ...envelope.images[0], base64: 'AAAA', sha256: imageDigest(Buffer.alloc(3)) }]) {
      await fails(receiveHostToolResult({ ...envelope, images: [image] }, new AbortController().signal), '');
    }
  } finally { await rm(dirname(artifacts[0]!.path), { recursive: true, force: true }); }
});

test('HTTP artifact transport is bounded before JSON parsing', async () => {
  expect(await readHostExchange(new Request('http://localhost', { method: 'POST', body: '{"protocol":1}' }))).toEqual({ protocol: 1 });
  await fails(readHostExchange(new Request('http://localhost', { method: 'POST', body: 'x'.repeat(HOST_EXCHANGE_BYTES + 1) })), 'exceeds');
});

test('approved host capture crosses relay, worker storage and native JSON-RPC image response without replay on restart', async () => {
  const bytes = png();
  const f = await fixture(`import {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.HOMIE_TOOL_OUTPUT_DIR+'/capture.png',Buffer.from('${bytes.toString('base64')}','base64'));\nconsole.log(JSON.stringify({result:{observed:true},images:['capture.png']}));`);
  const queue = new WorkerCustomToolQueue(), delivered = createDeferred<void>();
  const controller = new AbortController(), binding = bindingFor(f.scope.workspace, 'docker:test', f.scope.agentId, f.scope.accountId);
  const connection = { endpoint: 'http://127.0.0.1:12345/', token: 'fixture' }, journal = join(f.directory, 'receipts.json');
  let calls = 0;
  const relay = new AgentCustomToolRelay(async () => { calls++; return f.execute(); }, () => delivered.resolve(), async (_connection, body) => queue.exchange(body), journal);
  let client: AppServerClient | undefined, artifact: string | undefined;
  try {
    await f.allow();
    const pending = queue.call('homie_fixture', { text: 'fixture' }, controller.signal);
    const originalRequest = queue.exchange({ protocol: 1, results: [] });
    await relay.tick(binding, connection, () => true); await delivered.promise;
    await relay.tick(binding, connection, () => true);
    const result = await receiveHostToolResult(await pending, controller.signal);
    artifact = (result.artifacts as { path: string }[])[0]!.path;
    expect(await readFile(artifact)).toEqual(bytes); expect(calls).toBe(1);
    expect(await readFile(journal, 'utf8')).not.toContain(bytes.toString('base64'));
    const peer = join(f.directory, 'peer.ts');
    await writeFile(peer, `import {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='fixture/start')console.log(JSON.stringify({id:'tool-call',method:'item/tool/call',params:{}}));else if(m.id==='tool-call')console.log(JSON.stringify({id:1,result:m.result}));});`);
    client = new AppServerClient(process.execPath, undefined, [peer]); client.handleTools(async () => result);
    const response = await client.request('fixture/start', {});
    expect(response.success).toBe(true);
    expect(response.contentItems).toEqual(toolResponseContent(result));
    expect((response.contentItems as { type: string }[])[1]!.type).toBe('inputImage');
    await relay.dispose();
    let replayed: unknown;
    const restarted = new AgentCustomToolRelay(async () => { calls++; return f.execute(); }, () => {}, async (_connection, body) => {
      replayed = body; return originalRequest;
    }, journal);
    try {
      await restarted.tick(binding, connection, () => true); await restarted.tick(binding, connection, () => true);
      expect(replayed).toMatchObject({ results: [{ result: { isError: true } }] });
      expect(calls).toBe(1);
    } finally { await restarted.dispose(); }
  } finally {
    controller.abort(); await client?.close(); await relay.dispose();
    if (artifact) await rm(dirname(artifact), { recursive: true, force: true });
    await f.close();
  }
});
