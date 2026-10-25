import type { Stats } from 'node:fs';
import type { CanvasFileRelocation } from '../../shared/canvas.ts';

export interface CanvasFileLocation { path: string; identity: string | null }

export function canvasFileIdentity(info: Stats): string | null {
  if (!info.isFile() || !Number.isSafeInteger(info.ino) || info.ino <= 0) return null;
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

/** Recognize moves only by filesystem identity, never by names or equal bytes. */
export class CanvasFileLocations {
  private readonly known = new Map<string, string>();

  remember(path: string, identity: string | null): void {
    this.known.delete(path);
    if (identity !== null) this.known.set(path, identity);
    while (this.known.size > 1000) this.known.delete(this.known.keys().next().value!);
  }

  observe(files: CanvasFileLocation[], truncated: boolean): CanvasFileRelocation[] {
    if (truncated) return [];
    const paths = new Set(files.map(file => file.path));
    const byIdentity = new Map<string, string[]>();
    for (const file of files) if (file.identity !== null) {
      const matches = byIdentity.get(file.identity) ?? [];
      matches.push(file.path);
      byIdentity.set(file.identity, matches);
    }
    const moved: CanvasFileRelocation[] = [];
    for (const [previousPath, identity] of this.known) {
      const candidates = byIdentity.get(identity);
      if (!paths.has(previousPath) && candidates?.length === 1) {
        moved.push({ previousPath, path: candidates[0]! });
      }
    }
    for (const file of files) this.remember(file.path, file.identity);
    return moved;
  }
}
