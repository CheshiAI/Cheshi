import type { ToolHandlerState } from './tool-handler-state';

function isCorruptRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;
  // Older adapters may only preserve SQLite's message.
  return error.message === 'database disk image is malformed' || error.message === 'file is not a database';
}

/** Retry only a failed read, once; managed synchronization stays outside this boundary. */
export async function withReadConnectionRecovery<T>(
  state: ToolHandlerState,
  projectPath: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!state.readOnly || !isCorruptRead(error)) throw error;
    state.getCodeGraph(projectPath).reopenReadOnly();
    state.driftCache.clear();
    state.worktreeMismatchCache.clear();
    process.stderr.write('[CodeGraph MCP] Reopened a failed read-only database connection; retrying the read once.\n');
    return await operation();
  }
}
