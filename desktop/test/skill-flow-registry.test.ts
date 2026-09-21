import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineSkill, type ExecutableSkill } from '../lib/skill-flow-definition.mts';
import { createSkillRegistry, loadWorkspaceSkill, runRegisteredSkill } from '../lib/skill-flow-registry.mts';
import { runSkillFlow, type SkillFlowResult, type SkillFlowWorkflow } from '../lib/skill-flow-runtime.mts';
import type { SkillFlowJudge } from '../lib/skill-flow-judge.mts';

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-'));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const no: SkillFlowJudge = async () => ({ status: 'decided', value: false, choice: 'no', model: 'mock',
  inputTokens: null, outputTokens: null, elapsedMs: 0 });
const question = { condition: '추가 조사가 필요한가?', state: '자료가 충분함' };
async function execute(workflow: SkillFlowWorkflow, validate?: (result: SkillFlowResult) => boolean | Promise<boolean>) {
  return runSkillFlow(workflow, { judge: no, mode: 'mock', reportPath: path.join(await temporary(), 'result.md'), validate });
}

// These are actual exported execution contracts, deliberately independent of research/PPT work.
const noteSkill = defineSkill({ name: 'write-condition-note', parseInput(value: unknown) {
  if (typeof value !== 'string') throw new TypeError('Text required');
  return value;
}, async run(ctx, value, env) {
  const decision = await ctx.jev({ condition: '긴급한가?', state: value });
  const file = path.join(env.directory, 'note.md');
  await writeFile(file, decision ? 'urgent' : 'normal', { flag: 'wx' });
  return { outcome: 'success', artifacts: [file] };
}, async validate(result) {
  return result.artifacts?.length === 1 && ['urgent', 'normal'].includes(await readFile(result.artifacts[0]!, 'utf8'));
} });
const staticSkill = defineSkill({ name: 'static-function', parseInput: (value: unknown) => value,
  async run() { return { outcome: 'success' }; }, validate: result => result.outcome === 'success' });

test('two independent functions use one runner; no branch and no-judge work both succeed', async () => {
  const registry = createSkillRegistry([noteSkill, staticSkill]);
  expect(registry.list()).toEqual(['write-condition-note', 'static-function']);
  for (const name of registry.list()) {
    const result = await runRegisteredSkill(name, '내일 확인', { registry, judge: no, mode: 'mock', outputRoot: await temporary() });
    expect(result).toMatchObject({ outcome: 'success', reason: 'completed' });
    if (name === noteSkill.name) {
      expect(result.judgment?.value).toBe(false);
      expect(await readFile(result.artifacts[0]!, 'utf8')).toBe('normal');
    } else expect(result.judgment).toBeNull();
  }
});

test('an else branch completing normally is success, independent of false judgment', async () => {
  let completed = false;
  const result = await execute(async ctx => {
    if (await ctx.jev(question)) return { outcome: 'fail' };
    completed = true;
    return { outcome: 'success' };
  });
  expect(completed).toBe(true);
  expect(result).toMatchObject({ outcome: 'success', reason: 'completed', judgment: { value: false } });
});

test.each([null, undefined, true, 'success', [], { outcome: true }, { outcome: 'SUCCESS' }, { outcome: 'success', artifacts: ['relative.md'] }].map(value => ({ value })))
('fault injection: malformed function result never passes: %j', async ({ value }) => {
  const malformed: SkillFlowWorkflow = async (_ctx) => value as unknown as SkillFlowResult;
  const result = await execute(malformed);
  expect(result).toMatchObject({ outcome: 'fail', reason: 'validation_error' });
});

test.each([false, undefined, null, 'true', 1, {}])('fault injection: non-literal validator result is rejected: %s', async value => {
  const validate = async (_result: SkillFlowResult) => value as unknown as boolean;
  const result = await execute(async () => ({ outcome: 'success' }), validate);
  expect(result).toMatchObject({ outcome: 'fail', reason: 'validation_error' });
});

test('a verifier cannot rewrite the workflow outcome', async () => {
  const result = await execute(async () => ({ outcome: 'fail' }), async output => { output.outcome = 'success'; return true; });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'validation_error' });
});

test('validator rejection redacts internal exception details', async () => {
  const result = await execute(async () => ({ outcome: 'success' }), async () => { throw new Error('private secret detail'); });
  expect(result.reason).toBe('validation_error');
  expect(await readFile(result.reportPath, 'utf8')).not.toContain('private secret detail');
});

test.each(['missing', 'outside', 'symlink'])('fault injection: invalid artifact %s is rejected', async kind => {
  const root = await temporary(), outside = path.join(await temporary(), 'outside.md');
  await writeFile(outside, 'existing');
  let artifact = path.join(root, 'missing.md');
  if (kind === 'outside') artifact = outside;
  if (kind === 'symlink') { artifact = path.join(root, 'link.md'); await createSymbolicLink(outside, artifact); }
  const result = await runSkillFlow(async () => ({ outcome: 'success', artifacts: [artifact] }), {
    judge: no, reportPath: path.join(root, 'result.md'), mode: 'mock',
  });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'validation_error', artifacts: [] });
});

test('duplicate names and invalid executable contracts are rejected', () => {
  expect(() => createSkillRegistry([noteSkill, noteSkill])).toThrow();
  expect(() => createSkillRegistry([{ name: 'invalid' } as unknown as ExecutableSkill])).toThrow();
  expect(() => createSkillRegistry().get('../escape')).toThrow();
});

test('invalid input never reaches skill execution', async () => {
  const result = await runRegisteredSkill(noteSkill.name, 42, { registry: createSkillRegistry([noteSkill]),
    judge: no, outputRoot: await temporary(), mode: 'mock' });
  expect(result.outcome).toBe('fail');
  expect(result.judgments).toEqual([]);
});

test('missing prepared verifier prevents the task from executing', async () => {
  let executed = false;
  const malformed = { name: 'missing-verifier', prepare() {
    return { async run() { executed = true; return { outcome: 'success' }; } };
  } } as unknown as ExecutableSkill;
  const result = await runRegisteredSkill(malformed.name, {}, { registry: createSkillRegistry([malformed]),
    judge: no, outputRoot: await temporary(), mode: 'mock' });
  expect(result.reason).toBe('validation_error');
  expect(executed).toBe(false);
});

async function moduleFixture(name = 'test-function') {
  const root = await temporary();
  const folder = path.join(root, '.agents', 'skills', name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Test fixture\n---\n`);
  return { root, folder };
}

test('workspace module loads and executes without edits to the central registry', async () => {
  const { root, folder } = await moduleFixture();
  await writeFile(path.join(folder, 'workflow.mts'), `export default { name: 'test-function', prepare(input) {
    return { async run() { return { outcome: input === 'ok' ? 'success' : 'fail' }; }, validate() { return true; } };
  } };`);
  const loaded = await loadWorkspaceSkill('test-function', root);
  const result = await runRegisteredSkill('test-function', 'ok', { registry: createSkillRegistry([loaded]),
    judge: no, outputRoot: await temporary(), mode: 'mock' });
  expect(result.outcome).toBe('success');
});

test.each(['wrong-name', 'no-default', 'symlink'])('fault injection: broken module %s cannot load', async kind => {
  const { root, folder } = await moduleFixture();
  const target = path.join(folder, 'workflow.mts');
  if (kind === 'symlink') {
    const outside = path.join(await temporary(), 'outside.mts');
    await writeFile(outside, 'throw new Error("must not execute");');
    await createSymbolicLink(outside, target);
  } else await writeFile(target, kind === 'no-default' ? 'export const value = 1;'
    : 'export default { name: "wrong-name", prepare() {} };');
  let caught: unknown;
  try { await loadWorkspaceSkill('test-function', root); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toBe('must not execute');
});
