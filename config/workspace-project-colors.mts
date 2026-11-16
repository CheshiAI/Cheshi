import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface ProjectColor { roots: string[]; identity: string | null; hue: number; }
const palette = Array.from({ length: 12 }, (_, index) => (158 + index * 30) % 360);

function assertRecords(value: unknown): asserts value is { version: 1; projects: ProjectColor[] } {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('projects' in value) || !Array.isArray(value.projects)
    || value.projects.some((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return true;
      const item = entry as Record<string, unknown>;
      return !Array.isArray(item.roots) || !item.roots.length
        || item.roots.some((root: unknown) => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))
        || !(item.identity === null || typeof item.identity === 'string')
        || typeof item.hue !== 'number' || !palette.includes(item.hue);
    })) throw new Error('Invalid project color configuration.');
}

function directoryIdentity(root: string): string | null {
  try {
    const info = statSync(root, { bigint: true });
    return info.isDirectory() ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

function canonicalRoot(input: string): string {
  let ancestor = path.resolve(input);
  const suffix: string[] = [];
  while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

function nextHue(projects: ProjectColor[]): number {
  const distance = (left: number, right: number) => Math.min(Math.abs(left - right), 360 - Math.abs(left - right));
  const candidates = palette.map(hue => ({ hue, count: projects.filter(item => item.hue === hue).length,
    distance: projects.length ? Math.min(...projects.map(item => distance(hue, item.hue))) : 360 }));
  candidates.sort((left, right) => left.count - right.count || right.distance - left.distance);
  return candidates[0]!.hue;
}

/** Shared app-data assignments, independent of workspace ordering and UI lifetime. */
export function workspaceProjectColors(dataRoot: string, roots: readonly string[]): string[] {
  if (!path.isAbsolute(dataRoot) || dataRoot.includes('\0')) throw new Error('Select an absolute application data directory.');
  const filename = path.join(dataRoot, 'project-colors.json');
  const value: unknown = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : { version: 1, projects: [] };
  assertRecords(value);
  let changed = false;
  const colors = roots.map(input => {
    if (!path.isAbsolute(input) || input.includes('\0')) throw new Error('Select an absolute project folder.');
    const root = canonicalRoot(input);
    const identity = directoryIdentity(root);
    let entry = (identity ? value.projects.find(item => item.identity === identity) : undefined)
      ?? value.projects.find(item => item.roots.includes(root));
    if (!entry) {
      entry = { roots: [root], identity, hue: nextHue(value.projects) };
      value.projects.push(entry);
      changed = true;
    } else {
      if (!entry.roots.includes(root)) { entry.roots.push(root); changed = true; }
      if (identity && entry.identity !== identity) { entry.identity = identity; changed = true; }
    }
    return `hsl(${entry.hue} 32% 36%)`;
  });
  if (changed) {
    mkdirSync(dataRoot, { recursive: true });
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, filename);
    } finally { rmSync(temporary, { force: true }); }
  }
  return colors;
}
