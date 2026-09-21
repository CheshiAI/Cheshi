import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createSkillFlowJudge, type SkillFlowFetch, type SkillFlowQuestion } from '../desktop/lib/skill-flow-judge.mts';
import { runSkillFlow, type SkillFlowRun } from '../desktop/lib/skill-flow-runtime.mts';
import { branchCheck, completeResearch, incompleteResearch, partialResearch } from '../examples/skills/jev-branch-check/workflow.mts';

interface DemoCase {
  name: string;
  question: SkillFlowQuestion;
  expected: Pick<SkillFlowRun, 'outcome' | 'reason'>;
  request?: SkillFlowFetch;
}

function mockChoice(choice: 'yes' | 'no'): SkillFlowFetch {
  return async () => Response.json({
    model: 'mock-jev', answers: { condition: { type: 'choice', choice } },
  });
}

function demoCases(mode: 'mock' | 'live'): DemoCase[] {
  const cases: DemoCase[] = [
    { name: 'complete-research', question: completeResearch,
      expected: { outcome: 'success', reason: 'completed' },
      ...(mode === 'mock' ? { request: mockChoice('yes') } : {}) },
    { name: 'partial-research', question: partialResearch,
      expected: { outcome: 'fail', reason: 'declined' },
      ...(mode === 'mock' ? { request: mockChoice('no') } : {}) },
    { name: 'incomplete-research', question: incompleteResearch,
      expected: { outcome: 'fail', reason: 'declined' },
      ...(mode === 'mock' ? { request: mockChoice('no') } : {}) },
  ];
  if (mode === 'mock') cases.push(
    { name: 'http-error', question: completeResearch, request: async () => new Response('', { status: 429 }),
      expected: { outcome: 'fail', reason: 'judge_error' } },
    { name: 'invalid-response', question: completeResearch,
      request: async () => Response.json({ answers: { condition: { type: 'choice', choice: 'invalid' } } }),
      expected: { outcome: 'fail', reason: 'judge_error' } },
  );
  return cases;
}

export async function runSkillFlowDemo(options: {
  mode: 'mock' | 'live';
  outputRoot: string;
  getKey?: () => string | null;
}) {
  const root = path.resolve(options.outputRoot);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, `${options.mode}-`));
  const cases = demoCases(options.mode);
  await writeFile(path.join(directory, 'inputs.md'), ['# Jev에 전달한 조사 자료', '',
    '공식 문서를 직접 확인해 작성한 요약이며 원문 전체가 아닙니다. Jev는 전달된 내용만 평가합니다.', '',
    ...cases.map(scenario => `## ${scenario.name}\n\n판정 질문: ${scenario.question.condition}\n\n`
      + `\`\`\`json\n${JSON.stringify(scenario.question.state, null, 2)}\n\`\`\`\n`),
  ].join('\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const rows: Array<{ name: string; result: SkillFlowRun; passed: boolean }> = [];
  for (const scenario of cases) {
    const judge = createSkillFlowJudge({
      getKey: options.mode === 'mock' ? () => 'mock-only' : options.getKey ?? (() => process.env.TYPESAFE_API_KEY ?? null),
      request: scenario.request,
    });
    const result = await runSkillFlow(ctx => branchCheck(ctx, scenario.question), {
      judge, reportPath: path.join(directory, `${scenario.name}.md`), mode: options.mode,
    });
    rows.push({ name: scenario.name, result,
      passed: result.outcome === scenario.expected.outcome && result.reason === scenario.expected.reason });
  }
  const outcome = rows.every(row => row.passed) ? 'success' : 'fail';
  const reportPath = path.join(directory, 'summary.md');
  await writeFile(reportPath, [outcome, '', '# Jev skill branch test', '',
    `Mode: ${options.mode}`, '',
    '[Exact research inputs and condition](./inputs.md)', '',
    'Workflow output is the actual branch. Test result checks whether that branch matched the expected case.', '',
    '| Case | Workflow output | Reason | Test result |', '| --- | --- | --- | --- |',
    ...rows.map(row => `| [${row.name}](./${row.name}.md) | ${row.result.outcome} | ${row.result.reason} | ${row.passed ? 'success' : 'fail'} |`), '',
    options.mode === 'mock' ? 'No external API calls. This verifies execution and error handling, not model quality.'
      : 'Three cases use inspected official-source notes: all sources, Noul only, and no sources. Expected outcomes were fixed before the call. Errors are not model-quality results.', '',
  ].join('\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { outcome, reportPath, rows };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    live: { type: 'boolean', default: false },
    'output-root': { type: 'string', default: 'out/skill-flow' },
    help: { type: 'boolean', default: false },
  }, allowPositionals: false });
  if (values.help) {
    console.log('bun run scripts/skill-flow-demo.mts [--live] [--output-root DIRECTORY]');
    return;
  }
  if (values.live === true) {
    // Keep the saved key inside Electron's process; never pipe plaintext back to the CLI.
    const electron: string = createRequire(import.meta.url)('electron');
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(new URL('./skill-flow-live.mts', import.meta.url)),
      '--output-root', path.resolve(values['output-root'])], { env: environment, stdio: 'inherit' });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
    return;
  }
  const result = await runSkillFlowDemo({ mode: 'mock', outputRoot: values['output-root'] });
  console.log(`${result.outcome}: ${result.reportPath}`);
  if (result.outcome === 'fail') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(() => {
    console.error('Skill flow demo failed to run or save its report. Check arguments and output-directory access.');
    process.exitCode = 1;
  });
}
