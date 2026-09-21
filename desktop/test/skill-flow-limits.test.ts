import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSkillFlow, type SkillFlowContext, type SkillFlowResult } from '../lib/skill-flow-runtime.mts';
import { createSkillRegistry, runRegisteredSkill } from '../lib/skill-flow-registry.mts';
import { defineSkill } from '../lib/skill-flow-definition.mts';
import { createSkillFlowJudge } from '../lib/skill-flow-judge.mts';
import { sentenceQuestions } from '../lib/skill-flow-verification.mts';
import { skillFlowArguments } from '../../scripts/skill-flow-run.mts';
import { superviseSkillProcess } from '../../scripts/skill-flow-process.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-limits-'));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const question = { state: 'data', condition: '충분한가?' };
function fixture() {
  let calls = 0;
  const judge = createSkillFlowJudge({ getKey: () => 'test', request: async () => {
    calls++;
    return Response.json({ answers: { condition: { type: 'choice', choice: 'yes' } } });
  } });
  return { judge, calls: () => calls };
}

test('a never-resolving workflow times out and aborts the injected dependency signal', async () => {
  const started = createDeferred<AbortSignal>();
  const skill = defineSkill({ name: 'hanging-skill', parseInput: value => value,
    async run(_ctx, _input, env) { started.resolve(env.signal!); return new Promise<SkillFlowResult>(() => {}); },
    validate: () => true });
  const running = runRegisteredSkill(skill.name, {}, { registry: createSkillRegistry([skill]), judge: fixture().judge,
    mode: 'mock', outputRoot: await temporary(), timeoutMs: 20 });
  const signal = await started.promise;
  const result = await running;
  expect(result.reason).toBe('timeout');
  expect(signal.aborted).toBe(true);
  expect(await readFile(result.reportPath, 'utf8')).toContain('| reason | timeout |');
});

test('cancel ends waiting before an uncooperative workflow resolves and blocks subsequent judgment calls', async () => {
  const started = createDeferred<SkillFlowContext>();
  const release = createDeferred<void>();
  const controller = new AbortController();
  const f = fixture();
  const running = runSkillFlow(async ctx => {
    started.resolve(ctx);
    await release.promise;
    return { outcome: 'success' };
  }, { judge: f.judge, mode: 'mock', reportPath: path.join(await temporary(), 'result.md'), signal: controller.signal });
  const ctx = await started.promise;
  controller.abort();
  const result = await running;
  expect(result.reason).toBe('canceled');
  let rejected = false;
  try { await ctx.jev(question); } catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(f.calls()).toBe(0);
  release.resolve();
});

test('a hanging verifier also times out', async () => {
  const result = await runSkillFlow(async () => ({ outcome: 'success' }), { judge: fixture().judge, mode: 'mock',
    reportPath: path.join(await temporary(), 'result.md'), timeoutMs: 20, validate: () => new Promise<boolean>(() => {}) });
  expect(result.reason).toBe('timeout');
});

test('judgment budget stops a loop even if the workflow catches the budget error', async () => {
  const f = fixture();
  const result = await runSkillFlow(async ctx => {
    try { for (let i = 0; i < 10; i++) await ctx.jev(question); } catch { /* Intentional swallowed fault. */ }
    return { outcome: 'success' };
  }, { judge: f.judge, mode: 'mock', reportPath: path.join(await temporary(), 'result.md'), maxJudgments: 2 });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'call_limit' });
  expect(f.calls()).toBe(2);
  expect(result.judgments).toHaveLength(2);
});

test('a provider completing after cancellation cannot mutate the recorded decisions', async () => {
  const started = createDeferred<void>();
  const release = createDeferred<Awaited<ReturnType<ReturnType<typeof fixture>['judge']>>>();
  const controller = new AbortController();
  const running = runSkillFlow(async ctx => { await ctx.jev(question); return { outcome: 'success' }; }, {
    judge: async () => { started.resolve(); return release.promise; }, mode: 'mock', signal: controller.signal,
    reportPath: path.join(await temporary(), 'result.md'),
  });
  await started.promise;
  controller.abort();
  const result = await running;
  release.resolve(await fixture().judge(question));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(result.reason).toBe('canceled');
  expect(result.judgments).toEqual([]);
});

test.each(['0', '-1', 'NaN', '1.2', '3600001'])('CLI rejects invalid timeout %s', value => {
  expect(() => skillFlowArguments(['--input', 'input.json', '--timeout-ms', value])).toThrow();
});

test('CLI passes validated execution limits', () => {
  expect(skillFlowArguments(['--input', 'input.json', '--timeout-ms', '500', '--max-judgments', '3']))
    .toMatchObject({ timeoutMs: 500, maxJudgments: 3 });
});

test('an indivisible oversized claim is rejected without truncating its evidence', () => {
  expect(() => sentenceQuestions('가'.repeat(2000), passage => ({ condition: '근거 확인',
    state: { passage, notes: '나'.repeat(8000) } }))).toThrow();
});

test('parent watchdog terminates a child stuck in synchronous code', async () => {
  const child = spawn(process.execPath, ['-e', 'while (true) {}'], { stdio: 'ignore' });
  let forced = false;
  try {
    const supervisor = superviseSkillProcess(child, { timeoutMs: 20, graceMs: 20, onForcedStop: () => { forced = true; } });
    expect(await supervisor.completed).toBe(1);
    expect(forced).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('parent watchdog enforces cancellation even when SIGTERM is ignored', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const supervisor = superviseSkillProcess(child, { timeoutMs: 1000, graceMs: 20 });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    supervisor.interrupt();
    expect(await supervisor.completed).toBe(1);
    expect(child.signalCode).toBe('SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('default test command includes skill regressions', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  expect(pkg.scripts.test).toContain('bun run skill-flow:test');
  expect(pkg.scripts['skill-flow:test']).toContain('desktop/test/skill-flow-*.test.ts');
});
