import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SkillFlowJudge } from './skill-flow-judge.mts';
import { runSkillFlow, SkillFlowValidationError, type SkillFlowResult } from './skill-flow-runtime.mts';
import { assertSkillName, type ExecutableSkill } from './skill-flow-definition.mts';
import type { SkillFlowLimits } from './skill-flow-limits.mts';

export function createSkillRegistry(skills: readonly ExecutableSkill[] = []) {
  const entries = new Map<string, ExecutableSkill>();
  const register = (skill: ExecutableSkill) => {
    assertSkillName(skill?.name);
    if (typeof skill.prepare !== 'function' || entries.has(skill.name)) throw new TypeError('Invalid or duplicate skill registration.');
    entries.set(skill.name, skill);
  };
  skills.forEach(register);
  return { register, list: () => [...entries.keys()], get(name: string) {
    assertSkillName(name);
    const skill = entries.get(name);
    if (!skill) throw new TypeError('Unknown executable skill.');
    return skill;
  } };
}

/** Load trusted workspace code only from its repository skill directory. This is not a sandbox. */
export async function loadWorkspaceSkill(name: string, workspace: string): Promise<ExecutableSkill> {
  assertSkillName(name);
  const root = await realpath(workspace);
  const folder = path.join(root, '.agents', 'skills', name);
  for (const filename of ['SKILL.md', 'workflow.mts']) {
    const actual = await realpath(path.join(folder, filename));
    if (actual !== path.join(folder, filename)) throw new TypeError('Skill files must remain in their repository directory.');
  }
  const module = await import(pathToFileURL(path.join(folder, 'workflow.mts')).href);
  const registry = createSkillRegistry([module.default]);
  return registry.get(name);
}

export async function runRegisteredSkill(name: string, input: unknown, options: SkillFlowLimits & {
  registry: ReturnType<typeof createSkillRegistry>;
  judge: SkillFlowJudge;
  dependencies?: Readonly<Record<string, unknown>>;
  outputRoot: string;
  mode?: 'mock' | 'live';
  signal?: AbortSignal;
}) {
  const skill = options.registry.get(name);
  const root = path.resolve(options.outputRoot);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, `${name}-`));
  let validate: (result: SkillFlowResult) => boolean | Promise<boolean> = () => false;
  return runSkillFlow(async ctx => {
    const prepared = skill.prepare(input, { directory, signal: ctx.signal, dependencies: options.dependencies ?? {} });
    if (typeof prepared?.run !== 'function' || typeof prepared.validate !== 'function') throw new SkillFlowValidationError();
    await writeFile(path.join(directory, 'input.json'), JSON.stringify(input, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    validate = result => prepared.validate(result, ctx);
    return prepared.run(ctx);
  }, { judge: options.judge, mode: options.mode ?? 'live', signal: options.signal, artifactRoot: directory,
    timeoutMs: options.timeoutMs, maxJudgments: options.maxJudgments,
    reportPath: path.join(directory, 'result.md'), validate: result => validate(result) });
}
