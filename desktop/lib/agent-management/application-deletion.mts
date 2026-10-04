import { readApplicationRecords, assertApplicationRecords } from '../../../experiments/codex-specialists/src/application-storage.ts';
import type { DockerCommand } from './docker.mts';

/** Inspect the actual volume even for stopped workers and detached storage. Never starts a worker/model. */
export async function assertStoredApplications(run: DockerCommand, host: string, volume: string): Promise<void> {
  const script = `const fs=require('node:fs');console.log(JSON.stringify((${readApplicationRecords.toString()})(fs,'/agent')));`;
  let value: unknown;
  try {
    value = JSON.parse(await run(['--host', host, 'run', '--rm', '--pull', 'never', '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m',
      '--mount', `type=volume,src=${volume},dst=/agent,readonly`, '--entrypoint', 'bun', 'cheshi-specialist:1', '-e', script]));
  } catch { throw new Error('Cannot inspect application recovery storage. Start an updated worker before deleting; saved data was preserved.'); }
  assertApplicationRecords(value);
}
