import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillFlowJudge, type SkillFlowFetch, type SkillFlowJudge } from '../lib/skill-flow-judge.mts';
import { runSkillFlow, SkillFlowDecisionError } from '../lib/skill-flow-runtime.mts';
import { branchCheck, completeResearch } from '../../examples/skills/jev-branch-check/workflow.mts';
import { runSkillFlowDemo } from '../../scripts/skill-flow-demo.mts';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-skill-flow-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function judgeFor(choice: unknown) {
  const request: SkillFlowFetch = async () => Response.json({
    answers: { condition: { type: 'choice', choice } },
  });
  return createSkillFlowJudge({ getKey: () => 'test-only', request });
}

async function expectFailure(operation: Promise<unknown>): Promise<void> {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
}

test.each([
  ['yes', 'success', 'completed'], ['no', 'fail', 'declined'],
  ['invalid', 'fail', 'judge_error'],
] as const)('workflow writes %s as %s with reason %s', async (choice, outcome, reason) => {
  const reportPath = path.join(await temporaryDirectory(), 'result.md');
  const result = await runSkillFlow(ctx => branchCheck(ctx, completeResearch), {
    judge: judgeFor(choice), reportPath, mode: 'mock',
  });
  expect(result).toMatchObject({ outcome, reason, reportPath });
  const markdown = await readFile(reportPath, 'utf8');
  expect(markdown.split('\n')[0]).toBe(outcome);
  expect(markdown).toContain(`| reason | ${reason} |`);
  expect(markdown).toContain('| mode | mock |');
  expect(markdown).not.toMatch(/probability|confidence|threshold/i);
  if (reason === 'judge_error') expect(markdown).toContain('| error | invalid_response |');
});

test('a workflow exception produces fail without writing its private error message', async () => {
  const reportPath = path.join(await temporaryDirectory(), 'result.md');
  const result = await runSkillFlow(async () => { throw new Error('private information'); }, {
    judge: judgeFor('yes'), reportPath, mode: 'mock',
  });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'workflow_error' });
  expect(await readFile(reportPath, 'utf8')).not.toContain('private information');
});

test.each([['yes', true], ['no', false]] as const)('ctx.jev returns the literal boolean for %s', async (choice, expected) => {
  const branches: string[] = [];
  const result = await runSkillFlow(async ctx => {
    const decision: boolean = await ctx.jev(completeResearch);
    expect(decision).toBe(expected);
    if (decision) {
      branches.push('yes');
      return { outcome: 'success' };
    }
    branches.push('no');
    return { outcome: 'fail' };
  }, { judge: judgeFor(choice), reportPath: path.join(await temporaryDirectory(), 'result.md'), mode: 'mock' });
  expect(branches).toEqual([choice]);
  expect(result.judgment).toMatchObject({ status: 'decided', choice, value: expected });
  expect(result.reason).toBe(expected ? 'completed' : 'declined');
});

test.each(['network', 'http', 'invalid_response'] as const)('ctx.jev throws %s without entering either branch', async reason => {
  const branches: string[] = [];
  let caught: unknown;
  const request: SkillFlowFetch = async () => {
    if (reason === 'network') throw new Error('private network details');
    return reason === 'http' ? new Response('private provider details', { status: 429 })
      : Response.json({ answers: { condition: { type: 'choice', choice: 'invalid' } } });
  };
  const reportPath = path.join(await temporaryDirectory(), 'result.md');
  const result = await runSkillFlow(async ctx => {
    try {
      if (await ctx.jev(completeResearch)) branches.push('yes');
      else branches.push('no');
    } catch (error) {
      caught = error;
      throw error;
    }
    return { outcome: 'success' };
  }, { judge: createSkillFlowJudge({ getKey: () => 'test-only', request }), reportPath, mode: 'mock' });
  expect(caught).toBeInstanceOf(SkillFlowDecisionError);
  expect(branches).toEqual([]);
  expect(result).toMatchObject({ outcome: 'fail', reason: 'judge_error', judgment: { reason, value: null } });
  expect(await readFile(reportPath, 'utf8')).not.toContain('private');
});

test('truthy non-boolean judge output cannot reach a workflow branch', async () => {
  const reportPath = path.join(await temporaryDirectory(), 'result.md');
  const judgment = await judgeFor('yes')(completeResearch);
  const malformedJudge: SkillFlowJudge = async (_question, _signal) => ({
    ...judgment, value: 'true',
  }) as unknown as Awaited<ReturnType<SkillFlowJudge>>;
  const result = await runSkillFlow(ctx => branchCheck(ctx, completeResearch), {
    judge: malformedJudge, reportPath, mode: 'mock',
  });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'workflow_error' });
  expect((await readFile(reportPath, 'utf8')).split('\n')[0]).toBe('fail');
});

test('incomplete judge metadata becomes a recorded failure rather than breaking report creation', async () => {
  const reportPath = path.join(await temporaryDirectory(), 'result.md');
  const malformedJudge: SkillFlowJudge = async (_question, _signal) => ({
    status: 'decided', value: true, choice: 'yes',
  }) as unknown as Awaited<ReturnType<SkillFlowJudge>>;
  const result = await runSkillFlow(ctx => branchCheck(ctx, completeResearch), {
    judge: malformedJudge, reportPath, mode: 'mock',
  });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'workflow_error' });
  expect((await readFile(reportPath, 'utf8')).split('\n')[0]).toBe('fail');
});

test('existing reports are preserved and write failures are surfaced', async () => {
  const directory = await temporaryDirectory();
  const reportPath = path.join(directory, 'existing.md');
  await writeFile(reportPath, 'original');
  const workflow = (ctx: Parameters<typeof branchCheck>[0]) => branchCheck(ctx, completeResearch);
  await expectFailure(runSkillFlow(workflow, { judge: judgeFor('yes'), reportPath, mode: 'mock' }));
  expect(await readFile(reportPath, 'utf8')).toBe('original');
  await expectFailure(runSkillFlow(workflow, {
    judge: judgeFor('yes'), reportPath: path.join(reportPath, 'impossible.md'), mode: 'mock',
  }));
});

test('runtime cancellation reaches ctx.jev and produces a canceled fail report', async () => {
  const controller = new AbortController();
  controller.abort();
  const reportPath = path.join(await temporaryDirectory(), 'result.md');
  const result = await runSkillFlow(ctx => branchCheck(ctx, completeResearch), {
    judge: judgeFor('yes'), reportPath, mode: 'mock', signal: controller.signal,
  });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'canceled', judgment: null });
  expect(await readFile(reportPath, 'utf8')).toContain('| reason | canceled |');
});

test('mock demo verifies five cases and saves each actual branch separately', async () => {
  const result = await runSkillFlowDemo({ mode: 'mock', outputRoot: await temporaryDirectory(),
    getKey: () => { throw new Error('Mock mode must not read real credentials.'); } });
  expect(result.outcome).toBe('success');
  expect(result.rows).toHaveLength(5);
  expect(result.rows.map(row => row.result.outcome)).toEqual(['success', 'fail', 'fail', 'fail', 'fail']);
  for (const row of result.rows) {
    expect(row.passed).toBe(true);
    expect((await readFile(row.result.reportPath, 'utf8')).split('\n')[0]).toBe(row.result.outcome);
  }
  expect((await readFile(result.reportPath, 'utf8')).split('\n')[0]).toBe('success');
});

test('live mode without a key records failure, never claims a model-quality pass', async () => {
  const outputRoot = await temporaryDirectory();
  const result = await runSkillFlowDemo({ mode: 'live', outputRoot, getKey: () => null });
  expect(result.outcome).toBe('fail');
  expect(result.rows.every(row => row.passed === false)).toBe(true);
  for (const row of result.rows) {
    expect(row.result.judgment).toMatchObject({ status: 'error', reason: 'missing_key', value: null });
  }
  expect((await readFile(result.reportPath, 'utf8')).split('\n')[0]).toBe('fail');
});
