import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, type JsonRecord } from './protocol.ts';

export const SCRATCH_PROFILE = 'cheshi-test-scratch';

/** One turn's disposable test storage. Never grant write access to the project implicitly. */
export class TaskScratch {
  readonly directory: string;
  constructor(parent = tmpdir()) {
    this.directory = realpathSync(mkdtempSync(join(parent, 'cheshi-test-')));
  }

  config(workspace: string): JsonRecord {
    return {
      // Set the default as well as thread/turn permissions: Codex reloads
      // workspace requirements during model sampling using this config.
      default_permissions: SCRATCH_PROFILE,
      [`permissions.${SCRATCH_PROFILE}`]: {
        filesystem: { ':root': 'read', [workspace]: 'read', [this.directory]: 'write' },
        network: { enabled: false },
      },
      'shell_environment_policy.set': { TMPDIR: this.directory, TMP: this.directory, TEMP: this.directory },
    };
  }

  assertApplied(result: JsonRecord): void {
    const profile = record(result.activePermissionProfile), policy = record(result.sandbox);
    const roots = policy.writableRoots;
    if (profile.id !== SCRATCH_PROFILE || policy.type !== 'workspaceWrite' || policy.networkAccess !== false
      || policy.excludeTmpdirEnvVar !== true || policy.excludeSlashTmp !== true
      || !Array.isArray(roots) || roots.length !== 1 || roots[0] !== this.directory) {
      throw new Error('The test scratch permission profile was not applied. No task was started.');
    }
  }

  dispose(): void { rmSync(this.directory, { recursive: true, force: true }); }
}
