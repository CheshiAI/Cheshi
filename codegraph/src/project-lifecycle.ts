import { DatabaseConnection } from './db';
import { resolveWalValveMb, WalCheckpointValve } from './db/wal-valve';
import { getCodeGraphDir, isInitialized, validateDirectory } from './directory';
import * as path from 'path';

export function startWalCheckpointValve(
  db: DatabaseConnection,
  verbose: boolean | undefined,
): { walValve: WalCheckpointValve; priorAutocheckpoint: number } {
  const priorAutocheckpoint = db.getWalAutocheckpoint();
  db.setWalAutocheckpoint(0);
  const walValve = new WalCheckpointValve(
    db,
    resolveWalValveMb(process.env.CODEGRAPH_WAL_VALVE_MB, db.getDbFileSizeBytes()),
    undefined,
    verbose ? (message) => console.log(`[wal-valve] ${message}`) : undefined,
  );
  walValve.start();
  return { walValve, priorAutocheckpoint };
}

export async function stopWalCheckpointValve(walValve: WalCheckpointValve | null): Promise<void> {
  if (!walValve) return;
  walValve.stop();
  await walValve.drain();
}

export function resolveValidatedProjectRoot(projectRoot: string, readOnly = false): string {
  const resolvedRoot = path.resolve(projectRoot);
  if (!isInitialized(resolvedRoot)) {
    throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
  }
  const validation = validateDirectory(resolvedRoot, { readOnly });
  if (!validation.valid) {
    throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
  }
  return resolvedRoot;
}

export function throwDatabaseRebuildFailure(error: unknown, resolvedRoot: string): never {
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Could not rebuild the index — the database file is in use (${reason}). ` +
    `Stop any running CodeGraph MCP server/daemon for this project and retry, ` +
    `or remove the ${getCodeGraphDir(resolvedRoot)} directory and run "codegraph init".`
  );
}
