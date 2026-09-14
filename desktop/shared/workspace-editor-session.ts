export interface WorkspaceEditorSession {
  version: 1;
  paths: string[];
  selectedPath: string | null;
  splitRatio?: number;
}

function isWorkspaceFilePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/^[a-z]:/i.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export function parseWorkspaceEditorSession(value: unknown): WorkspaceEditorSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid workspace editor session.');
  }
  const session = value as Record<string, unknown>;
  if (session.version !== 1 || !Array.isArray(session.paths) || session.paths.length > 500
    || !session.paths.every(isWorkspaceFilePath) || new Set(session.paths).size !== session.paths.length
    || (session.selectedPath !== null
      && (typeof session.selectedPath !== 'string' || !session.paths.includes(session.selectedPath)))
    || (session.splitRatio !== undefined && (typeof session.splitRatio !== 'number'
      || !Number.isFinite(session.splitRatio) || session.splitRatio < 0.1 || session.splitRatio > 0.9))
    || Object.keys(session).some(key => !['version', 'paths', 'selectedPath', 'splitRatio'].includes(key))) {
    throw new TypeError('Invalid workspace editor session.');
  }
  return { version: 1, paths: [...session.paths], selectedPath: session.selectedPath,
    ...(typeof session.splitRatio === 'number' ? { splitRatio: session.splitRatio } : {}) };
}
