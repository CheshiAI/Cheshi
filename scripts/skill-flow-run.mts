import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { skillFlowLimits } from '../desktop/lib/skill-flow-limits.mts';
import { superviseSkillProcess } from './skill-flow-process.mts';

export function skillFlowArguments(args: string[]) {
  const { values } = parseArgs({ args, options: {
    skill: { type: 'string', default: 'jev-research-report' },
    input: { type: 'string' }, 'output-root': { type: 'string', default: 'out/skill-flow' },
    help: { type: 'boolean', default: false },
    'timeout-ms': { type: 'string' }, 'max-judgments': { type: 'string' },
  }, allowPositionals: false });
  if (!values.help && !values.input) throw new TypeError('--input is required.');
  const limits = skillFlowLimits({ timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    maxJudgments: values['max-judgments'] === undefined ? undefined : Number(values['max-judgments']) });
  return { ...values, ...limits };
}

async function main() {
  const args = skillFlowArguments(process.argv.slice(2));
  if (args.help) {
    console.log('bun run scripts/skill-flow-run.mts --input REQUEST.json [--skill NAME] [--output-root DIRECTORY] [--timeout-ms 300000] [--max-judgments 64]');
    return;
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const electron: string = createRequire(import.meta.url)('electron');
  const child = spawn(electron, [fileURLToPath(new URL('./skill-flow-run-live.mts', import.meta.url)),
    '--skill', args.skill, '--input', path.resolve(args.input!), '--output-root', path.resolve(args['output-root']),
    '--timeout-ms', String(args.timeoutMs), '--max-judgments', String(args.maxJudgments)],
  { cwd: process.cwd(), env: environment, stdio: 'inherit' });
  const supervisor = superviseSkillProcess(child, { timeoutMs: args.timeoutMs,
    onForcedStop: () => console.error('Skill process exceeded its deadline and was stopped. A result report may be unavailable.') });
  const interrupt = () => supervisor.interrupt();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    process.exitCode = await supervisor.completed;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(() => { console.error('Skill flow could not start. Check arguments and runtime access.'); process.exitCode = 1; });
}
