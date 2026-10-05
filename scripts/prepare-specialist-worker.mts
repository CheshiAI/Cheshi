import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Explicit build context: never package experiment fixtures, local auth, or test output. */
export const SPECIALIST_WORKER_FILES = [
  'Dockerfile', 'package.json', 'tsconfig.json', 'profiles/verifier/AGENTS.md',
  'src/change-stream.ts', 'src/idle-lifecycle.ts', 'src/worker.ts', 'src/agent.ts', 'src/app-server-client.ts', 'src/protocol.ts',
  'src/activity.ts', 'src/activity-contract.ts', 'src/store.ts', 'src/turn.ts', 'src/execution-health.ts', 'src/command-stop.ts', 'src/runtime-config.ts', 'src/task-scratch.ts',
  'src/usage-contract.ts', 'src/native-usage.ts',
  'src/verification-contract.ts', 'src/verification-tools.ts', 'src/verification.ts',
  'src/application-storage.ts', 'src/application-contract.ts', 'src/integration-application.ts',
  'src/work-contract.ts', 'src/work-files.ts', 'src/work.ts', 'src/work-tools.ts',
  'src/candidate-verification-contract.ts', 'src/verification-candidate-files.ts', 'src/integration-contract.ts', 'src/integration-plan.ts', 'src/integration.ts',
  'src/conversation.ts', 'src/conversation-contract.ts', 'src/decision.ts', 'src/goal-progress.ts', 'src/question-control.ts', 'src/recovery.ts', 'src/history.ts', 'src/history-queue.ts', 'src/history-inspection.ts', 'src/history-tools.ts',
  'src/collaboration-contract.ts', 'src/collaboration-tools.ts', 'src/collaboration.ts',
  'security/codex-bwrap.json', 'security/cheshi-codex-bwrap.apparmor', 'security/vendor/LICENSE',
] as const;
export async function prepareSpecialistWorker(source: string, target: string): Promise<void> {
  const destinationRoot = resolve(target);
  if (destinationRoot === resolve(source) || destinationRoot === resolve('/')) throw new Error('Invalid worker staging directory.');
  await rm(destinationRoot, { recursive: true, force: true });
  for (const filename of SPECIALIST_WORKER_FILES) {
    const destination = join(target, filename);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(source, filename), destination);
  }
}
