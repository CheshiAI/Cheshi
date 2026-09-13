export type GitDiscardScope = 'working' | 'staged';

export interface GitDiscardTarget {
  path: string;
  scope: GitDiscardScope;
}

export interface GitDiscardFilePreview extends GitDiscardTarget {
  oldPath: string | null;
  action: 'restore-index' | 'restore-head' | 'trash';
}

export interface GitDiscardSelection {
  targets: GitDiscardTarget[];
}

export interface GitDiscardPreview {
  files: GitDiscardFilePreview[];
  revision: string;
}

export interface GitDiscardRequest extends GitDiscardSelection {
  expectedRevision: string;
  confirmed: true;
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Git discard request must be an object.');
  }
  return value as Record<string, unknown>;
}

export function gitDiscardTarget(value: unknown): GitDiscardTarget {
  const request = requestRecord(value);
  const filePath = request.path;
  if (
    typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')
    || filePath.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(filePath)
    || filePath.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw new TypeError('Choose one file inside the workspace to discard.');
  }
  if (request.scope !== 'working' && request.scope !== 'staged') {
    throw new TypeError('Git discard scope must be working or staged.');
  }
  return { path: filePath, scope: request.scope };
}

export function gitDiscardRequest(value: unknown): GitDiscardRequest {
  const selection = gitDiscardSelection(value);
  const request = requestRecord(value);
  if (request.confirmed !== true) throw new TypeError('Confirm the file before discarding changes.');
  if (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedRevision)) {
    throw new TypeError('Refresh the discard preview before continuing.');
  }
  return { ...selection, confirmed: true, expectedRevision: request.expectedRevision };
}

export function gitDiscardSelection(value: unknown): GitDiscardSelection {
  const request = requestRecord(value);
  if (!Array.isArray(request.targets) || request.targets.length < 1) {
    throw new TypeError('Select between 1 and 1000 files to discard.');
  }
  const targets = new Map<string, GitDiscardTarget>();
  for (const value of request.targets) {
    const target = gitDiscardTarget(value);
    if (!targets.has(target.path) || target.scope === 'staged') targets.set(target.path, target);
    if (targets.size > 1_000) throw new TypeError('Select between 1 and 1000 files to discard.');
  }
  return { targets: [...targets.values()] };
}
