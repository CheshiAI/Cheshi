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
    || !record.paths.every((path): path is string => typeof path === 'string' && path.length > 0 && path.length <= 4096
      && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
      && !path.split('/').some(part => part === '..' || part === '.' || part === ''))
    || new Set(record.paths).size !== record.paths.length
    || (record.selectedPath !== null && (typeof record.selectedPath !== 'string' || !record.paths.includes(record.selectedPath)))) {
    throw new TypeError('Invalid editor session.');
  }
  return { version: 1, paths: [...record.paths], selectedPath: record.selectedPath as string | null };
}
