import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROJECT_DOC_MAX_BYTES, parseProjectDocMaxBytes } from '../../experiments/codex-specialists/src/project-instructions.ts';
import { isCodexAccountId } from '../shared/codex-accounts.ts';

interface Options { settingsPath: string }
export interface WorkspaceAccountSelection {
  read(): string | null;
  write(id: string): void;
}

function accountSelections(preferences: Record<string, unknown>): Record<string, unknown> {
  const value = preferences.workspaceAccountSelections;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Shared app preferences, updated atomically across workspace windows. */
export function createSettingsService(options: Options) {
  const projectDocListeners = new Set<(bytes: number) => void>();
  const readPreferences = (): Record<string, unknown> => {
    try {
      return assertPreferences(JSON.parse(readFileSync(options.settingsPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('Could not read app settings.');
    }
  };
  // Synchronous read/modify/replace keeps all windows' writes ordered on the main thread.
  const updatePreferences = (update: (preferences: Record<string, unknown>) => Record<string, unknown>, message: string) => {
    const temporary = `${options.settingsPath}.${randomUUID()}.tmp`;
    try {
      const preferences = update(readPreferences());
      mkdirSync(path.dirname(options.settingsPath), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, options.settingsPath);
    } catch { throw new Error(message); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* A failed write does not replace the saved preference. */ } }
  };
  return {
    getProjectDocMaxBytes() {
      const value = readPreferences().projectDocMaxBytes;
      return value === undefined ? DEFAULT_PROJECT_DOC_MAX_BYTES : parseProjectDocMaxBytes(value);
    },
    setProjectDocMaxBytes(value: unknown) {
      const bytes = parseProjectDocMaxBytes(value);
      updatePreferences(preferences => ({ ...preferences, projectDocMaxBytes: bytes }),
        'Could not save the instruction size limit. Try again.');
      for (const listener of projectDocListeners) listener(bytes);
      return bytes;
    },
    subscribeProjectDocMaxBytes(listener: (bytes: number) => void) {
      projectDocListeners.add(listener);
      return () => { projectDocListeners.delete(listener); };
    },
    workspaceAccountSelection(workspaceRoot: string): WorkspaceAccountSelection {
      const workspace = path.resolve(workspaceRoot);
      return {
        read() {
          const value = accountSelections(readPreferences())[workspace];
          return isCodexAccountId(value) ? value : null;
        },
        write(id) {
          if (!isCodexAccountId(id)) throw new TypeError('Invalid account profile id.');
          updatePreferences(preferences => ({
            ...preferences,
            workspaceAccountSelections: { ...accountSelections(preferences), [workspace]: id },
          }), 'Could not save the workspace account selection. Try again.');
        },
      };
    },
  };
}

function assertPreferences(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid app settings.');
  return value as Record<string, unknown>;
}
