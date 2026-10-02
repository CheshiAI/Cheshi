import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Explicit build context: never package experiment fixtures, local auth, or test output. */
export const SPECIALIST_WORKER_FILES = [
  'Dockerfile', 'package.json', 'tsconfig.json', 'profiles/verifier/AGENTS.md',
  'src/worker.ts', 'src/agent.ts', 'src/app-server-client.ts', 'src/protocol.ts',
  'src/store.ts', 'src/turn.ts', 'src/runtime-config.ts',
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
