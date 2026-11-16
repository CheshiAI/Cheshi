import { validWorkspaceFilePath } from './workspace-projects.ts';
export interface EditorSession {
  version: 1;
  paths: string[];
  selectedPath: string | null;
}

export interface EditorSessionApi {
  read(): Promise<EditorSession | null>;
  save(session: EditorSession): Promise<void>;
}

export type EditorSessionMode = 'waiting' | 'restore' | 'preserve' | 'blocked';

export function parseEditorSession(value: unknown): EditorSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid editor session.');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.paths) || record.paths.length > 500
    || !record.paths.every(validWorkspaceFilePath)
    || new Set(record.paths).size !== record.paths.length
    || (record.selectedPath !== null && (typeof record.selectedPath !== 'string' || !record.paths.includes(record.selectedPath)))) {
    throw new TypeError('Invalid editor session.');
  }
  return { version: 1, paths: [...record.paths], selectedPath: record.selectedPath as string | null };
}
