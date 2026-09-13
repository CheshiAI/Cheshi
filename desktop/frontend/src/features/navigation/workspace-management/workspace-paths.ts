export function parentDirectory(path: string): string {
  if (/^\/+$/u.test(path)) return '/';
  if (/^[a-z]:[\\/]+$/iu.test(path)) return path.slice(0, 3);
  const normalized = path.replace(/[\\/]+$/, '');
  const separator = normalized.includes('\\') ? '\\' : '/';
  const index = normalized.lastIndexOf(separator);
  return index < 0 ? '' : normalized.slice(0, index + (index === 0 || normalized[index - 1] === ':' ? 1 : 0));
}

export function childDirectory(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`;
}

export function repositoryDirectoryName(url: string): string {
  return url.trim().replace(/[?#].*$/, '').replace(/\/$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '') ?? '';
}

export function validDirectoryName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !/[\\/:]/u.test(trimmed) && !trimmed.startsWith('-') && trimmed !== '.' && trimmed !== '..';
}

export function workspaceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method ['"]cheshi:workspace-management:[^'"]+['"]:\s*(?:Error:\s*)?/u, '');
}
