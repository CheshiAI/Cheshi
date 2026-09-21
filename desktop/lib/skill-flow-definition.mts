import type { SkillFlowContext, SkillFlowResult } from './skill-flow-runtime.mts';

export interface SkillEnvironment {
  directory: string;
  signal?: AbortSignal;
  dependencies: Readonly<Record<string, unknown>>;
}
export interface SkillDefinition<Input = unknown> {
  name: string;
  parseInput(value: unknown): Input;
  run(ctx: SkillFlowContext, input: Input, environment: SkillEnvironment): Promise<SkillFlowResult>;
  validate(result: SkillFlowResult, input: Input, environment: SkillEnvironment, ctx: SkillFlowContext): boolean | Promise<boolean>;
}
export interface ExecutableSkill {
  name: string;
  prepare(value: unknown, environment: SkillEnvironment): {
    run(ctx: SkillFlowContext): Promise<SkillFlowResult>;
    validate(result: SkillFlowResult, ctx: SkillFlowContext): boolean | Promise<boolean>;
  };
}

export function assertSkillName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new TypeError('Invalid skill name.');
  }
}

/** Typed functions remain skill-owned; the runner only coordinates their contract. */
export function defineSkill<Input>(definition: SkillDefinition<Input>): ExecutableSkill {
  assertSkillName(definition.name);
  if (typeof definition.parseInput !== 'function' || typeof definition.run !== 'function'
    || typeof definition.validate !== 'function') throw new TypeError('Incomplete executable skill.');
  return Object.freeze({ name: definition.name, prepare(value: unknown, environment: SkillEnvironment) {
    const input = definition.parseInput(value);
    return { run: (ctx: SkillFlowContext) => definition.run(ctx, input, environment),
      validate: (result: SkillFlowResult, ctx: SkillFlowContext) => definition.validate(result, input, environment, ctx) };
  } });
}
