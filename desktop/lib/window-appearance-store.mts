import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_WINDOW_APPEARANCE, parseWindowAppearance } from '../shared/window-appearance.ts';
import type { WindowAppearance } from '../shared/window-appearance.ts';

export function createWindowAppearanceStore(filename: string) {
  const listeners = new Set<() => void>();
  const read = (): WindowAppearance => {
    try { return parseWindowAppearance(JSON.parse(readFileSync(filename, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_WINDOW_APPEARANCE };
      throw new Error('Could not read appearance settings.');
    }
  };
  return {
    read,
    save(value: unknown) {
      const preferences = parseWindowAppearance(value);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, filename);
      } finally { rmSync(temporary, { force: true }); }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const stores = new Map<string, ReturnType<typeof createWindowAppearanceStore>>();
export function windowAppearanceStore(filename: string) {
  let store = stores.get(filename);
  if (!store) { store = createWindowAppearanceStore(filename); stores.set(filename, store); }
  return store;
}
