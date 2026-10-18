import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostToolRegistration } from '../lib/agent-management/host-tool-registration.mts';
import { HostToolServices } from '../lib/agent-management/host-tool-services.mts';
import { parseCustomTools, hostServiceRequired, customToolTimeoutMs } from '../../experiments/codex-specialists/src/custom-tool-contract';
import { WorkerCustomToolQueue } from '../../experiments/codex-specialists/src/custom-tool-queue';
import { AgentCustomToolRelay } from '../lib/agent-orchestration/custom-tool-relay.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol';
import { parseAgentPackage } from '../shared/agent-package';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import type { SpecialistAgent } from '../shared/agent-registry';
import { hostToolReviewDetails, hostToolReviewSummary } from '../lib/agent-management/host-tool-review-content.mts';

async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Condition did not complete.');
    await Bun.sleep(20);
  }
}
const supervisor = `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.HOMIE_SERVICE_SOURCE_DIR+'/starts', process.pid+'\\n');
createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({ok:true}))).on('close',()=>process.exit(0));`;

async function fixture(serviceScript = supervisor) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'host-service-')));
  const tools = parseCustomTools(['first', 'second'].map(name => ({ name, description: name, enabled: true,
    runtime: 'bun', execution: 'host', script: 'scripts/tool.ts',
    parameters: [{ name: 'request', type: 'string', description: 'Action', required: true }],
    service: { name: 'server', script: 'scripts/service.ts', when: { parameter: 'request', jsonField: 'action', values: ['begin'] } } })));
  const pack = parseAgentPackage({ ...(await officialAgentPackages())[0], tools, resources: { programs: [], files: [
    { path: 'scripts/service.ts', content: serviceScript },
    { path: 'scripts/tool.ts', content: 'console.log(JSON.stringify({result:{deviceAction:true}}));' },
  ] } });
  const agent: SpecialistAgent = { id: 'fixture', revision: 1, name: 'fixture', role: 'custom', instructions: 'fixture',
    createdAt: '', updatedAt: '', accountId: 'account', permissions: { fileWrite: false, commandExecution: true },
    model: null, reasoningEffort: null, serviceTier: null, assignments: [{ workspaceRoot: directory, instructions: '' }], package: pack };
  let sourceDirectory = directory;
  const registration = new HostToolRegistration(join(directory, 'state'), () => agent, async () => sourceDirectory);
  const scope = { workspace: directory, agentId: agent.id, accountId: agent.accountId! };
  const allow = async (index: number) => registration.request(directory, { action: 'allow', agentId: agent.id, tool: tools[index]!.name }, {
    selectExecutable: async () => process.execPath,
    confirm: async review => {
      expect(hostToolReviewSummary(review).detail).toContain('maintains local service');
      expect(hostToolReviewDetails(review)).toContain(directory);
      expect(review.service?.script).toBe('scripts/service.ts'); return true;
    },
  });
  const execute = (index = 0, action = 'begin', signal = new AbortController().signal) => registration.execute(scope, tools[index]!,
    { request: JSON.stringify({ action }) }, signal, () => true);
  const starts = async () => (await readFile(join(directory, 'starts'), 'utf8')).trim().split('\n').map(Number);
  const gone = async () => {
    for (const pid of await starts()) { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    return true;
  };
  return { directory, registration, agent, tools, allow, execute, starts, gone,
    setSource: (value: string) => { sourceDirectory = value; },
    close: async () => { registration.dispose(); await Bun.sleep(100); await rm(directory, { recursive: true, force: true }); } };
}

test('host service declarations require host execution, packaged scripts and matching shared definitions', async () => {
  const f = await fixture();
  try {
    const tool = f.tools[0]!;
    expect(() => parseCustomTools([{ ...tool, execution: undefined }])).toThrow('host');
    expect(() => parseCustomTools([{ ...tool, service: { name: 'server', script: '../run.ts' } }])).toThrow('script');
    expect(() => parseAgentPackage({ ...f.agent.package, resources: { programs: [], files: f.agent.package!.resources!.files.slice(1) } })).toThrow('Missing service');
    expect(() => parseAgentPackage({ ...f.agent.package, tools: [tool, { ...f.tools[1], service: { name: 'server', script: 'scripts/tool.ts' } }] })).toThrow('must match');
    expect(hostServiceRequired(tool, { request: '{"action":"begin"}' })).toBe(true);
    for (const request of ['bad json', 'null', '{"action":true}', '{"action":"close"}']) expect(hostServiceRequired(tool, { request })).toBe(false);
  } finally { await f.close(); }
});

test('two approved tools serialize startup and reuse one supervised service across completed calls', async () => {
  const f = await fixture();
  try {
    await fails(f.execute(), 'Allow');
    await f.allow(0); await f.allow(1);
    const results = await Promise.all([f.execute(0), f.execute(1)]);
    expect(results.map(r => r.data)).toEqual([{ deviceAction: true }, { deviceAction: true }]);
    expect((await f.starts()).length).toBe(1);
    expect((await f.execute()).data).toEqual({ deviceAction: true });
    const completedTurn = new AbortController();
    await f.execute(0, 'begin', completedTurn.signal); completedTurn.abort();
    expect((await f.execute()).data).toEqual({ deviceAction: true });
    expect((await f.starts()).length).toBe(1);
    f.registration.dispose(); await until(f.gone);
  } finally { await f.close(); }
});

test('service preparation reserves a bounded worker deadline that the host relay accepts', async () => {
  const f = await fixture(), queue = new WorkerCustomToolQueue(), delivered = createDeferred<void>();
  const relay = new AgentCustomToolRelay(async () => ({ ok: true }), () => delivered.resolve(), async (_connection, body) => queue.exchange(body));
  const controller = new AbortController();
  try {
    const args = { request: '{"action":"begin"}' };
    expect(customToolTimeoutMs(f.tools[0]!, args)).toBe(90_000);
    expect(customToolTimeoutMs(f.tools[0]!, { request: '{"action":"close"}' })).toBe(60_000);
    const result = queue.call('homie_first', args, controller.signal, customToolTimeoutMs(f.tools[0]!, args));
    const queued = queue.exchange({ protocol: 1, results: [] }).requests[0]!;
    expect(queued.deadline - Date.now()).toBeGreaterThan(85_000);
    const binding = bindingFor(f.directory, 'docker:test', f.agent.id, f.agent.accountId!);
    const connection = { endpoint: 'http://127.0.0.1:12345/', token: 'fixture' };
    await relay.tick(binding, connection, () => true); await delivered.promise;
    await relay.tick(binding, connection, () => true);
    expect(await result).toEqual({ ok: true });
  } finally { controller.abort(); await relay.dispose(); await f.close(); }
});

test('cleanup actions do not start a service; failed preparation prevents the device tool', async () => {
  const f = await fixture(supervisor.replace('{ok:true}', '{ok:false,error:{code:"port_conflict",message:"Existing port occupied"}}'));
  try {
    await f.allow(0);
    expect((await f.execute(0, 'close')).data).toEqual({ deviceAction: true });
    const result = await f.execute();
    expect(result.data).toMatchObject({ ok: false, error: { code: 'port_conflict' }, outcome: 'not_completed', automaticRetry: false });
    await until(f.gone);
  } finally { await f.close(); }
});

test('revoking approval or changing command permissions stops an owned service between calls', async () => {
  for (const change of ['revoke', 'permission', 'revision', 'policy']) {
    const f = await fixture();
    try {
      if (change === 'policy') await f.registration.request(f.directory, { action: 'policy', agentId: f.agent.id, tool: 'first', autoApprove: true });
      await f.allow(0); await f.execute();
      if (change === 'revoke') await f.registration.request(f.directory, { action: 'revoke', agentId: f.agent.id, tool: 'first' });
      else if (change === 'permission') f.agent.permissions.commandExecution = false;
      else if (change === 'revision') f.agent.revision++;
      else await f.registration.request(f.directory, { action: 'policy', agentId: f.agent.id, tool: 'first', autoApprove: false });
      await until(f.gone);
    } finally { await f.close(); }
  }
});

test('service startup has a deadline, cancellation and bounded protocol output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-errors-'));
  try {
    for (const script of ['setInterval(()=>{},1000);', 'console.log("x".repeat(17000));setInterval(()=>{},1000);', 'console.log("not json");setInterval(()=>{},1000);']) {
      const services = new HostToolServices(directory, 100);
      try {
        await fails(services.ensure({ key: 'one', owner: 'one', fingerprint: 'one', executable: process.execPath,
          script: 'scripts/service.ts', sourceDirectory: directory, files: [{ path: 'scripts/service.ts', content: script }], valid: () => true },
        new AbortController().signal), 'service');
      } finally { services.dispose(); }
    }
    const f = await fixture(supervisor.replace("()=>console.log(JSON.stringify({ok:true}))", '()=>{}'));
    try {
      await f.allow(0);
      const controller = new AbortController();
      const pending = fails(f.execute(0, 'begin', controller.signal), 'canceled');
      await until(async () => { try { return (await f.starts()).length === 1; } catch { return false; } });
      controller.abort(); await pending; await until(f.gone);
    } finally { await f.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('service tools receive the reviewed source even without starting the service, and reject source moves', async () => {
  const f = await fixture();
  try {
    f.agent.package!.resources!.files.find(file => file.path === 'scripts/tool.ts')!.content =
      'console.log(JSON.stringify({result:{source:process.env.HOMIE_TOOL_SOURCE_DIR}}));';
    await f.allow(0);
    expect((await f.execute(0, 'close')).data).toEqual({ source: f.directory });
    expect((await f.execute()).data).toEqual({ source: f.directory });
    f.setSource(join(f.directory, 'state'));
    await fails(f.execute(0, 'close'), 'source changed');
  } finally { await f.close(); }
});
