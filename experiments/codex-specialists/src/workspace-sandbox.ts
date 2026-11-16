import { accessSync, constants } from 'node:fs';

// A Docker bind configured as writable can still inherit a read-only VM share.
// Detect that before starting Codex; its bwrap metadata error obscures the cause.
// Do not create files or relax the native sandbox's protected-path rules.
export function assertWritableWorkspace(workspace: string): void {
  try {
    accessSync(workspace, constants.W_OK);
  } catch (cause) {
    throw new Error('Workspace is not writable. Check the container mount and VM file-sharing permissions before resuming this task.', { cause });
  }
}
