import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillFlowJudge, SkillFlowJudgment, SkillFlowQuestion } from './skill-flow-judge.mts';
import { createSkillFlowScope, SkillFlowLimitError, type SkillFlowLimits } from './skill-flow-limits.mts';

export interface SkillFlowContext {
  readonly signal: AbortSignal;
  jev(question: SkillFlowQuestion, signal?: AbortSignal): Promise<boolean>;
}
export interface SkillFlowResult {
  outcome: 'success' | 'fail';
  artifacts?: string[];
}
export class SkillFlowValidationError extends Error {
  constructor() { super('Skill result validation failed.'); this.name = 'SkillFlowValidationError'; }
}
export class SkillFlowDecisionError extends Error {
  readonly judgment: Extract<SkillFlowJudgment, { status: 'error' }>;

  constructor(judgment: Extract<SkillFlowJudgment, { status: 'error' }>) {
    super(`Jev judgment failed: ${judgment.reason}`);
    this.name = 'SkillFlowDecisionError';
    this.judgment = judgment;
  }
}
export type SkillFlowWorkflow = (ctx: SkillFlowContext) => Promise<SkillFlowResult>;
export type SkillFlowRun = {
  outcome: 'success' | 'fail';
  reason: 'completed' | 'declined' | 'judge_error' | 'workflow_error' | 'validation_error' | 'canceled' | 'timeout' | 'call_limit';
  judgment: SkillFlowJudgment | null;
  judgments: SkillFlowJudgment[];
  artifacts: string[];
  reportPath: string;
};

function markdownCell(value: string | number | null): string {
  return String(value ?? 'unknown').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

function assertJudgment(judgment: SkillFlowJudgment): void {
  if (!judgment || !['decided', 'error'].includes(judgment.status)
    || !Number.isFinite(judgment.elapsedMs) || judgment.elapsedMs < 0
    || (judgment.status === 'decided' && judgment.value !== true && judgment.value !== false)
    || (judgment.status !== 'decided' && judgment.value !== null)
    || (judgment.status === 'error' && judgment.choice !== null)
    || (judgment.status === 'decided' && ((judgment.choice !== 'yes' && judgment.choice !== 'no')
      || judgment.value !== (judgment.choice === 'yes')))) {
    throw new TypeError('Invalid skill flow judgment.');
  }
}

function assertResult(result: SkillFlowResult): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || (result.outcome !== 'success' && result.outcome !== 'fail')
    || (result.artifacts !== undefined && (!Array.isArray(result.artifacts)
      || !result.artifacts.every(artifact => typeof artifact === 'string' && path.isAbsolute(artifact))))) {
    throw new SkillFlowValidationError();
  }
}

function assertVerified(value: unknown): void {
  if (value !== true) throw new SkillFlowValidationError();
}

async function validateArtifacts(artifacts: string[], root: string): Promise<void> {
  try {
    const base = await realpath(root);
    for (const artifact of artifacts) {
      const resolved = await realpath(artifact);
      const relative = path.relative(base, resolved);
      assertVerified(relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative) && (await stat(resolved)).isFile());
    }
  } catch { throw new SkillFlowValidationError(); }
}

/** Executes an imported workflow once. SKILL.md is documentation, never evaluated as code. */
export async function runSkillFlow(workflow: SkillFlowWorkflow, options: SkillFlowLimits & {
  judge: SkillFlowJudge;
  reportPath: string;
  mode: 'mock' | 'live';
  signal?: AbortSignal;
  artifactRoot?: string;
  validate?(result: SkillFlowResult, ctx: SkillFlowContext): boolean | Promise<boolean>;
}): Promise<SkillFlowRun> {
  let outcome: SkillFlowRun['outcome'] = 'fail';
  let reason: SkillFlowRun['reason'] = 'workflow_error';
  const state: { judgment: SkillFlowJudgment | null } = { judgment: null };
  const judgments: SkillFlowJudgment[] = [];
  let artifacts: string[] = [];
  const scope = createSkillFlowScope(options);
  const ctx: SkillFlowContext = { signal: scope.signal, jev: async (question, signal) => {
    scope.consumeJudgment();
    const judgment = await scope.wait(() => options.judge(question,
      signal ? AbortSignal.any([scope.signal, signal]) : scope.signal));
    scope.signal.throwIfAborted();
    assertJudgment(judgment);
    state.judgment = judgment;
    judgments.push(judgment);
    if (judgment.status === 'error') throw new SkillFlowDecisionError(judgment);
    return judgment.value === true;
  } };
  try {
    scope.signal.throwIfAborted();
    const result = await scope.wait(() => workflow(ctx));
    scope.signal.throwIfAborted();
    assertResult(result);
    Object.freeze(result);
    if (result.artifacts) Object.freeze(result.artifacts);
    if (options.validate) {
      try { assertVerified(await scope.wait(async () => options.validate!(result, ctx))); }
      catch (error) {
        if (error instanceof SkillFlowDecisionError) throw error;
        throw new SkillFlowValidationError();
      }
    }
    scope.signal.throwIfAborted();
    if (result.artifacts?.length) await scope.wait(() => validateArtifacts(result.artifacts!,
      options.artifactRoot ?? path.dirname(path.resolve(options.reportPath))));
    scope.signal.throwIfAborted();
    outcome = result.outcome;
    artifacts = result.artifacts ?? [];
    reason = outcome === 'success' ? 'completed' : 'declined';
  } catch (error) {
    if (options.signal?.aborted) reason = 'canceled';
    else if (scope.signal.reason instanceof SkillFlowLimitError) reason = scope.signal.reason.reason;
    else if (error instanceof SkillFlowValidationError) reason = 'validation_error';
    else if (error instanceof SkillFlowDecisionError) reason = 'judge_error';
    // Unexpected workflow failures produce fail without leaking exception contents.
  } finally { scope.close(); }
  const judgment = state.judgment;
  const reportPath = path.resolve(options.reportPath);
  const rows: Array<[string, string | number | null]> = [
    ['mode', options.mode], ['reason', reason], ['judgment', judgment?.status ?? 'unavailable'],
    ['value', judgment?.value === true ? 'true' : judgment?.value === false ? 'false' : 'null'],
    ['choice', judgment?.choice ?? null], ['model', judgment?.model ?? null],
    ['provider', judgment?.provider ?? null],
    ['elapsedMs', judgment?.elapsedMs ?? null],
    ['inputTokens', judgment?.inputTokens ?? null], ['outputTokens', judgment?.outputTokens ?? null],
  ];
  if (judgment?.status === 'error') {
    rows.push(['error', judgment.reason]);
    if (judgment.httpStatus !== undefined) rows.push(['httpStatus', judgment.httpStatus]);
  }
  const markdown = [outcome, '', '# Skill flow result', '',
    '| Field | Value |', '| --- | --- |',
    ...rows.map(([key, value]) => `| ${key} | ${markdownCell(value)} |`), '',
    ...artifacts.map(artifact => `[${path.basename(artifact)}](<${artifact.replaceAll('>', '%3E')}>)`), '',
    '## Decision calls', '', '| Call | Provider | Status | Choice | Error |', '| --- | --- | --- | --- | --- |',
    ...judgments.flatMap((entry, index) => (entry.attempts ?? [{ ...entry, provider: entry.provider ?? 'jev' }])
      .map(call => `| ${index + 1} | ${call.provider} | ${call.status} | ${call.choice ?? ''} | ${'reason' in call ? call.reason : ''} |`)), '',
    options.mode === 'mock' ? 'Mock response; no external API was called.'
      : 'Live mode; missing credentials or request errors are recorded as fail.', '',
  ].join('\n');
  await mkdir(path.dirname(reportPath), { recursive: true });
  // A report belongs to one run; do not overwrite a previous result or follow an existing symlink.
  await writeFile(reportPath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { outcome, reason, judgment, judgments, artifacts, reportPath };
}
