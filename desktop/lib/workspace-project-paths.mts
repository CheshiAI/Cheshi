import path from 'node:path';
import type { WorkspaceProject } from '../shared/workspace-projects.ts';
import { parseEditorSession, type EditorSession } from '../shared/editor-session.ts';
import { normalizeRelativePath } from './workspace-file-paths.mts';

const pathFields = new Set(['path', 'previousPath', 'directoryPath', 'destinationDirectory']);

/** Only documented path fields are translated; file contents and patches are opaque. */
export function mapProjectPaths(value: unknown, map: (file: string) => string, field = ''): unknown {
  if (typeof value === 'string') return pathFields.has(field) || field === 'paths' ? map(value) : value;
  if (Array.isArray(value)) return value.map(item => mapProjectPaths(item, map, field));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapProjectPaths(item, map, key)]));
}

export function projectForPath(projects: WorkspaceProject[], value: string): WorkspaceProject {
  if (!path.isAbsolute(value)) { normalizeRelativePath(value); return projects[0]!; }
  const project = projects.find(entry => {
    const relative = path.relative(entry.rootPath, value);
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
  if (!project) throw new Error('The file is outside the connected projects.');
  // Reject traversal even if its normalized destination falls inside a project.
  if (value.split(/[\\/]/u).includes('..') || value.includes('\0')) throw new Error('Invalid project path.');
  return project;
}

/** Keep session metadata inside current project membership without changing file access rules. */
export function filterProjectEditorSession(projects: WorkspaceProject[], value: unknown): EditorSession {
  const session = parseEditorSession(value);
  const paths = session.paths.filter(file => {
    try { return Boolean(projectForPath(projects, file)); }
    catch { return false; }
  });
  return { ...session, paths, selectedPath: session.selectedPath === null || paths.includes(session.selectedPath)
    ? session.selectedPath : paths[0] ?? null };
}

export function relativeProjectPath(project: WorkspaceProject, value: string): string {
  if (!path.isAbsolute(value)) return normalizeRelativePath(value) || '.';
  const relative = path.relative(project.rootPath, value);
  if (path.isAbsolute(relative)) throw new Error('The file is outside the selected project.');
  return normalizeRelativePath(relative) || '.';
}

export function qualifiedProjectPath(project: WorkspaceProject, value: string): string {
  return project.primary ? value : path.join(project.rootPath, normalizeRelativePath(value)).split(path.sep).join('/');
}
