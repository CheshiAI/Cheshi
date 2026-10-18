import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostToolRegistration } from '../lib/agent-management/host-tool-registration.mts';
import type { HostPythonProvider } from '../lib/agent-management/host-python-runtime.mts';
import { parseAgentPackage } from '../shared/agent-package';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import type { SpecialistAgent } from '../shared/agent-registry';
import { parseCustomTools } from '../../experiments/codex-specialists/src/custom-tool-contract';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol';
import { hostToolReviewDetails, hostToolReviewSummary } from '../lib/agent-management/host-tool-review-content.mts';

async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'python-registration-')));
  // Only interpreter acquisition is replaced; grant, execution and service paths are real.
  const executable = await realpath(process.execPath);
  const python: HostPythonProvider = { prepare: async () => ({ id: 'managed-fixture', version: '3.14.8', executable }),
    matches: (path, id, version) => path === executable && id === 'managed-fixture' && version === '3.14.8', dispose() {} };
  const tools = parseCustomTools(['first', 'second'].map(name => ({ name, description: name, enabled: true,
    runtime: 'python3', runtimeVersion: '3.14.8', execution: 'host', parameters: [], script: 'scripts/run.ts',
    service: { name: 'fixture', script: 'scripts/service.ts' } })));
  const pack = parseAgentPackage({ ...(await officialAgentPackages())[0], tools, resources: { programs: [], files: [
    { path: 'scripts/run.ts', content: 'console.log(JSON.stringify({result:{executed:true,userSite:process.env.PYTHONNOUSERSITE}}));' },
    { path: 'scripts/service.ts', content: `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({ok:process.env.PYTHONNOUSERSITE==='1'})));` },
  ] } });
  const agent: SpecialistAgent = { id: 'fixture', revision: 1, createdAt: '', updatedAt: '', name: 'fixture', role: 'custom', instructions: 'fixture',
    accountId: 'account', permissions: { fileWrite: false, commandExecution: true }, model: null, reasoningEffort: null, serviceTier: null,
    assignments: [{ workspaceRoot: directory, instructions: '' }], package: pack };
  const service = new HostToolRegistration(join(directory, 'state'), () => agent, async () => directory, python);
  const scope = { workspace: directory, agentId: agent.id, accountId: agent.accountId! };
  let selections = 0, confirmations = 0;
  const ui = { selectExecutable: async () => { selections++; throw new Error('Python picker must not open'); }, confirm: async () => { confirmations++; return true; } };
  const request = { agentId: agent.id, tool: tools[0]!.name };
  const execute = () => service.execute(scope, agent.package!.tools![0]!, {}, new AbortController().signal, () => true);
  return { directory, python, service, agent, tools, ui, request, execute, counts: () => ({ selections, confirmations }),
    close: async () => { service.dispose(); await Bun.sleep(100); await rm(directory, { recursive: true, force: true }); } };
}

test('Python and its service require access approval but never ask for a system executable', async () => {
  const f = await fixture();
  try {
    await fails(f.execute(), 'Allow');
    expect((await f.service.request(f.directory, { ...f.request, action: 'status' })).allowed).toBe(false);
    const declined = await f.service.request(f.directory, { ...f.request, action: 'allow' }, { ...f.ui, confirm: async review => {
      expect(hostToolReviewSummary(review).detail).toContain('Cheshi-managed Python');
      expect(hostToolReviewDetails(review)).toContain('managed-fixture'); return false;
    } });
    expect(declined.allowed).toBe(false); await fails(f.execute(), 'Allow');
    for (const tool of f.tools) expect((await f.service.request(f.directory, { ...f.request, tool: tool.name, action: 'allow' }, f.ui)).allowed).toBe(true);
    expect((await f.execute()).data).toEqual({ executed: true, userSite: '1' });
    expect(f.counts()).toEqual({ selections: 0, confirmations: 2 });
    expect(JSON.stringify(f.agent.package)).not.toContain(process.execPath);
  } finally { await f.close(); }
});

test('package updates still require approval, while a runtime change cannot reuse its previous grant', async () => {
  const f = await fixture();
  try {
    await f.service.request(f.directory, { ...f.request, action: 'allow' }, f.ui);
    f.agent.package!.description += ' updated'; f.agent.revision++;
    await fails(f.execute(), 'Allow');
    await f.service.request(f.directory, { ...f.request, action: 'allow' }, f.ui);
    expect(f.counts()).toEqual({ selections: 0, confirmations: 2 });
    f.agent.package!.tools = f.tools.map(tool => ({ ...tool, runtimeVersion: '3.15.0' }));
    await f.service.request(f.directory, { ...f.request, action: 'policy', autoApprove: true });
    await fails(f.execute(), 'Allow');
  } finally { await f.close(); }
});

test('permission revoked during Python preparation cannot be restored by the pending review', async () => {
  const f = await fixture(), prepared = createDeferred<void>(), continuePreparation = createDeferred<void>();
  const original = f.python.prepare;
  f.python.prepare = async () => { prepared.resolve(); await continuePreparation.promise; return original(); };
  try {
    const pending = fails(f.service.request(f.directory, { ...f.request, action: 'allow' }, f.ui), 'changed during review');
    await prepared.promise;
    await f.service.request(f.directory, { ...f.request, action: 'revoke' });
    continuePreparation.resolve(); await pending;
    await fails(f.execute(), 'Allow');
  } finally { continuePreparation.resolve(); await f.close(); }
});

test('failed runtime preparation does not select a system Python or grant access', async () => {
  const f = await fixture();
  f.python.prepare = async () => { throw new Error('download failed'); };
  try {
    await fails(f.service.request(f.directory, { ...f.request, action: 'allow' }, f.ui), 'download failed');
    expect(f.counts()).toEqual({ selections: 0, confirmations: 0 });
    await fails(f.execute(), 'Allow');
  } finally { await f.close(); }
});

test('legacy system-Python grants require migration through review even with an unchanged bundle', async () => {
  const f = await fixture();
  try {
    await f.service.request(f.directory, { ...f.request, action: 'allow' }, f.ui);
    const grants = join(f.directory, 'state', 'grants');
    const path = join(grants, (await readdir(grants))[0]!);
    const legacy = JSON.parse(await readFile(path, 'utf8')); delete legacy.managedRuntime;
    await writeFile(path, JSON.stringify(legacy));
    expect((await f.service.request(f.directory, { ...f.request, action: 'status' })).allowed).toBe(false);
    await fails(f.execute(), 'Cheshi-managed runtime');
    await f.service.request(f.directory, { ...f.request, action: 'allow' }, f.ui);
    expect((await f.execute()).data).toMatchObject({ executed: true });
    expect(f.counts().selections).toBe(0);
  } finally { await f.close(); }
});

test('managed Python declarations survive parsing and cannot be applied to container or other runtimes', async () => {
  const f = await fixture();
  try {
    expect(parseAgentPackage(JSON.parse(JSON.stringify(f.agent.package))).tools![0]!.runtimeVersion).toBe('3.14.8');
    for (const patch of [{ runtime: 'node' }, { execution: undefined }, { runtimeVersion: '../python' }, { runtimeVersion: true }]) {
      expect(() => parseCustomTools([{ ...f.tools[0], ...patch }])).toThrow('runtimeVersion');
    }
    expect(() => parseAgentPackage({ ...f.agent.package, tools: [f.tools[0], { ...f.tools[1], runtimeVersion: '3.15.0' }] })).toThrow('must match');
  } finally { await f.close(); }
});
