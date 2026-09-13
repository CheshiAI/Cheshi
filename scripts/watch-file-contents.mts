import { createHash } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';

function contentFingerprint(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'base64');
    return createHash('sha256').update(content, 'base64').digest('hex');
  } catch {
    return null;
  }
}

/**
 * Watch a fixed set of files and report only real content changes.
 *
 * Watching their parent directories keeps the watcher alive across atomic
 * replacements. Comparing content filters out duplicate and metadata-only
 * events that `fs.watch` may emit on macOS while a file is merely opened.
 *
 */
export function watchFileContents(
  filePaths: string[],
  onChange: (filePath: string) => void,
): FSWatcher[] {
  const fingerprints = new Map(filePaths.map((filePath) => [filePath, contentFingerprint(filePath)]));
  const pathsByDirectory = new Map<string, Map<string, string>>();

  for (const filePath of filePaths) {
    const directory = path.dirname(filePath);
    const entries = pathsByDirectory.get(directory) ?? new Map();
    entries.set(path.basename(filePath), filePath);
    pathsByDirectory.set(directory, entries);
  }

  return [...pathsByDirectory.entries()].map(([directory, entries]) => watch(directory, (_eventType, filename) => {
    const changedPaths = filename === null
      ? [...entries.values()]
      : [entries.get(filename.toString())].filter((filePath) => filePath !== undefined);

    for (const filePath of changedPaths) {
      const nextFingerprint = contentFingerprint(filePath);
      if (fingerprints.get(filePath) === nextFingerprint) continue;
      fingerprints.set(filePath, nextFingerprint);
      onChange(filePath);
    }
  }));
}
