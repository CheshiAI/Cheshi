import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, type JsonRecord } from './protocol.ts';
import { TaskOutput } from './task-output.ts';

export const SCRATCH_PROFILE = 'cheshi-test-scratch';

/** One turn's disposable test storage. Never grant write access to the project implicitly. */
export class TaskScratch {
  readonly directory: string;
  readonly output?: TaskOutput;
  constructor(parent = tmpdir(), archive?: string) {
    this.directory = realpathSync(mkdtempSync(join(parent, 'cheshi-test-')));
    if (archive) this.output = new TaskOutput(this.directory, archive);
  }

  config(workspace: string, projectWritable = false): JsonRecord {
    return {
      // Set the default as well as thread/turn permissions: Codex reloads
      // workspace requirements during model sampling using this config.
      default_permissions: SCRATCH_PROFILE,
      [`permissions.${SCRATCH_PROFILE}`]: {
        filesystem: { ':root': 'read', [workspace]: projectWritable ? 'write' : 'read', [this.directory]: 'write',
          ...(projectWritable ? Object.fromEntries(['.git', '.agents', '.codex', '.aws'].map(name => [join(workspace, name), 'read'])) : {}),
        },
        network: { enabled: false },
      },
      'shell_environment_policy.set': { TMPDIR: this.directory, TMP: this.directory, TEMP: this.directory,
        ...(this.output ? { CHESHI_TASK_OUTPUT_DIR: this.output.directory } : {}) },
    };
  }

  assertApplied(result: JsonRecord, writableProject?: string): void {
    const profile = record(result.activePermissionProfile), policy = record(result.sandbox);
    const roots = policy.writableRoots;
    // Native Codex omits cwd from writableRoots when cwd is implicitly writable.
    // The named profile carries the explicit project read/write rule.
    const expected = new Set([this.directory, ...(writableProject ? [writableProject] : [])]);
    if (profile.id !== SCRATCH_PROFILE || policy.type !== 'workspaceWrite' || policy.networkAccess !== false
      || policy.excludeTmpdirEnvVar !== true || policy.excludeSlashTmp !== true
      || !Array.isArray(roots) || !roots.includes(this.directory) || new Set(roots).size !== roots.length || !roots.every(root => expected.has(root))) {
      throw new Error('The test scratch permission profile was not applied. No task was started.');
    }
  }

  dispose(): void {
    if (this.output && existsSync(this.directory)) this.output.preserve();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
