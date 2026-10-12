import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHomieExecutor, type HomieExecutionProfile } from '../lib/agent-platform/homie-executor.mts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';
import { fixture, plan, taskInput, assertFailure } from './agent-platform-fixtures.ts';
import { AgentFlashMemory } from '../lib/flash/agent-memory.mts';
import { dockerMemoryOwner } from '../lib/flash/docker-archive.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';

export const homieProfile = (): HomieExecutionProfile => ({ agentId: 'agent-feature', accountId: 'fixture-account',
  assertCurrent() {}, credentials: async () => JSON.stringify({ tokens: { access_token: 'fixture-secret' } }),
  configuration: { accountId: 'fixture-account', profileId: 'agent-feature', role: 'development', instructions: 'Follow project instructions.',
    model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: true, commandExecution: true }, enabledTools: [] } });

function mockDocker(options: { loseReceipt?: boolean; wrongTask?: boolean; unconfirmedStop?: boolean; foreign?: boolean; waiting?: boolean } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const id = 'b'.repeat(64);
  let created = false, status = 'created', name = '', runId = '', workspace = '', requests = 0;
  const run: DockerCommand = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///fixture/docker.sock' } } }]);
    expect(args.slice(0, 2)).toEqual(['--host', 'unix:///fixture/docker.sock']);
    if (args[2] === 'container') {
      const command = args[3];
      if (command === 'ls') return created ? id : '';
      if (command === 'create') {
        created = true; name = args[args.indexOf('--name') + 1]!; runId = name.slice('cheshi-platform-homie-'.length);
        workspace = args.find(a => a.startsWith('type=bind,src=') && a.endsWith('dst=/workspace'))!.slice('type=bind,src='.length).split(',')[0]!;
        return id;
      }
      if (command === 'inspect') return JSON.stringify([{ Id: id, Name: `/${name}`, Image: plan.image,
        Config: { Labels: { 'ai.cheshi.platform-homie': options.foreign ? 'other' : runId } }, State: { Status: status } }]);
      if (command === 'start') { status = 'running'; return id; }
      if (command === 'stop') { if (!options.unconfirmedStop) status = 'exited'; return id; }
      if (command === 'rm') { created = false; return id; }
    }
    if (args[2] === 'exec') {
      const payload = JSON.parse(input!);
      if (payload.auth) return '';
      if (payload.route === '/health') return JSON.stringify({ status: 200, body: { ready: true } });
      if (payload.route === '/account') return JSON.stringify({ status: 200, body: { authenticated: true } });
      if (payload.route === '/flash/history') return JSON.stringify({ status: 200, body: {
        revision: 'a'.repeat(64), session: { threadId: 'native-thread', title: 'Isolated original', entries: [
          { turnId: 'turn', itemId: 'message', kind: 'assistant', text: 'Preserved isolated decision' },
        ] }, next: null,
      } });
      if (payload.route === '/flash/exchange') return JSON.stringify({ status: 200, body: { protocol: 1, requests: [] } });
      if (payload.route === '/tasks') {
        requests++; writeFileSync(join(workspace, 'feature.txt'), 'from Homie');
        if (options.loseReceipt) throw new Error('Lost task acknowledgement');
        return JSON.stringify({ status: 202, body: { id: runId, status: 'accepted' } });
      }
      return JSON.stringify({ status: 200, body: { id: options.wrongTask ? 'other' : runId, status: options.waiting ? 'waiting' : 'completed',
        threadId: 'native-thread', output: 'Implemented the change', error: null } });
    }
    throw new Error(`Unexpected command ${args[2]} ${args[3]}`);
  };
  return { run, calls, requests: () => requests };
}

test('real Git admits Homie results only after the owned isolated container stops, and persists session evidence', async () => {
  const mock = mockDocker(), profile = homieProfile();
  const homie = await createHomieExecutor({ engineId: 'docker:test', buildContext: '/worker', profile, run: mock.run, pollMs: 1 });
  const f = await fixture(homie);
  try {
    f.platform.enqueue(taskInput('feature'));
    const result = await f.platform.runTask('feature'), attempt = result.attempts[0]!;
    expect(result.status).toBe('succeeded'); expect(attempt.receipt?.session?.threadId).toBe('native-thread');
    expect(attempt.receipt?.session?.accountId).toBe('fixture-account');
    const create = mock.calls.find(c => c.args[3] === 'create')!.args;
    expect(create.filter(a => a.startsWith('type=bind'))).toEqual([
      `type=bind,src=${attempt.workspace},dst=/workspace`, `type=bind,src=${attempt.workspace}/.git,dst=/workspace/.git,readonly`,
    ]);
    expect(create.some(a => a.startsWith('/agent:rw,') && a.includes('mode=0700'))).toBe(true);
    expect(create).not.toContain('--publish'); expect(create).not.toContain('--privileged');
    expect(create.join(' ')).not.toContain('fixture-secret'); expect(create.filter(a => a.startsWith('type=bind')).join(' ')).not.toContain('docker.sock');
    expect(mock.calls.some(c => c.input?.includes('fixture-secret'))).toBe(true);
    expect(mock.calls.some(c => c.args[3] === 'stop')).toBe(true);
    expect(mock.requests()).toBe(1);
    await homie.cleanup(attempt.id);
  } finally { f.dispose(); }
});

test('isolated task archives completed originals before tmpfs is stopped and retains them after container cleanup', async () => {
  const mock = mockDocker(), profile = homieProfile();
  const homie = await createHomieExecutor({ engineId: 'docker:test', buildContext: '/worker', profile, run: mock.run, pollMs: 1 });
  const f = await fixture(homie);
  const memory = new AgentFlashMemory(f.root, () => true, { transaction: async () => { throw new Error('No model query expected.'); }, release: async () => {} });
  profile.flash = memory; profile.workspace = f.repository;
  profile.configuration.flashProtocol = 1;
  const binding = bindingFor(f.repository, 'docker:test', profile.agentId, profile.accountId);
  try {
    f.platform.enqueue(taskInput('feature'));
    const result = await f.platform.runTask('feature');
    expect(result.status).toBe('succeeded');
    const exportIndex = mock.calls.findLastIndex(c => c.input && JSON.parse(c.input).route === '/flash/history');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(mock.calls.findIndex(c => c.args[3] === 'stop'));
    await homie.cleanup(result.attempts[0]!.id);
    const sources = (await memory.archive.sources(dockerMemoryOwner(binding))).sources;
    expect(sources).toHaveLength(1); expect(sources[0]!.document.text).toBe('Preserved isolated decision');
  } finally { await memory.dispose(); f.dispose(); }
});

for (const kind of ['loseReceipt', 'wrongTask', 'unconfirmedStop', 'waiting'] as const) {
  test(`Homie ${kind} cannot yield a successful commit or automatic replay`, async () => {
    const mock = mockDocker({ [kind]: true });
    const homie = await createHomieExecutor({ engineId: 'docker:test', buildContext: '/worker', profile: homieProfile(), run: mock.run, pollMs: 1 });
    const f = await fixture(homie);
    try {
      f.platform.enqueue(taskInput('feature'));
      const result = await f.platform.runTask('feature');
      expect(result.status).toBe('unknown'); expect(result.attempts[0]!.resultCommit).toBeNull();
      await assertFailure(f.platform.runTask('feature'), /not queued/); expect(mock.requests()).toBe(1);
    } finally { f.dispose(); }
  });
}

test('ownership mismatch never installs the selected account or starts the container', async () => {
  const mock = mockDocker({ foreign: true });
  const homie = await createHomieExecutor({ engineId: 'docker:test', buildContext: '/worker', profile: homieProfile(), run: mock.run });
  const f = await fixture(homie);
  try {
    f.platform.enqueue(taskInput('feature')); expect((await f.platform.runTask('feature')).status).toBe('unknown');
    expect(mock.calls.some(c => c.input?.includes('fixture-secret'))).toBe(false);
    expect(mock.calls.some(c => c.args[3] === 'start')).toBe(false);
  } finally { f.dispose(); }
});
