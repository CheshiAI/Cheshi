export interface WorkspaceProject {
  id: string;
  name: string;
  rootPath: string;
  primary: boolean;
  available: boolean;
}

export interface WorkspaceProjectsApi {
  list(): Promise<WorkspaceProject[]>;
  add(): Promise<WorkspaceProject[] | null>;
  remove(id: string): Promise<WorkspaceProject[]>;
  onChanged(listener: () => void): () => void;
  invoke(id: string, channel: string, args: unknown[]): Promise<unknown>;
}

export function absoluteProjectPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
}

export function projectFilePath(project: Pick<WorkspaceProject, 'rootPath' | 'primary'>, relative: string): string {
  if (project.primary) return relative;
  return relative === '.' ? project.rootPath : `${project.rootPath.replace(/[\\/]$/u, '')}/${relative}`;
}

export function workspaceFullPath(root: string, file: string): string {
  return absoluteProjectPath(file) ? file : `${root.replace(/[\\/]$/u, '')}/${file}`;
}

/** Structural validation only; main-process routing checks project membership. */
export function validWorkspaceFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || /[\x00-\x1f]/u.test(value)) return false;
  const relative = value.replace(/^(?:[A-Za-z]:)?\//u, '');
  return relative.split('/').every(part => !!part && part !== '.' && part !== '..');
}
