import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWorkspaceEditorSession } from '../shared/workspace-editor-session.ts';
import type { WorkspaceEditorSession } from '../shared/workspace-editor-session.ts';

export function createWorkspaceEditorSessionStore(filePath: string) {
  return {
    read(): WorkspaceEditorSession | null {
      try {
        if (statSync(filePath).size > 16 * 1024 * 1024) return null;
        return parseWorkspaceEditorSession(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError
          || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write(value: unknown): void {
      const session = parseWorkspaceEditorSession(value);
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, `${JSON.stringify(session)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        renameSync(temporaryPath, filePath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    },
  };
}
