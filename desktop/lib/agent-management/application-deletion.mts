import { readApplicationRecords, assertApplicationRecords } from '../../../experiments/codex-specialists/src/application-storage.ts';
import type { DockerCommand } from './docker.mts';

/** Inspect the actual volume even for stopped workers and detached storage. Never starts a worker/model. */
export async function assertStoredApplications(run: DockerCommand, host: string, volume: string): Promise<void> {
  const script = `const fs=require('node:fs');console.log(JSON.stringify((${readApplicationRecords.toString()})(fs,'/agent')));`;
  let value: unknown;
  try {
    // Worker state can belong to the host UID or an older image UID. This reader
    // needs only DAC read/search access; neither the volume nor rootfs is writable.
    value = JSON.parse(await run(['--host', host, 'run', '--rm', '--pull', 'never', '--network', 'none',
      '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
      '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m',
      '--mount', `type=volume,src=${volume},dst=/agent,readonly`, '--entrypoint', 'node', 'cheshi-specialist:1', '-e', script]));
  } catch { throw new Error('Cannot inspect application recovery storage. Check Docker availability and storage access, then retry deletion; saved data was preserved.'); }
  assertApplicationRecords(value);
}
