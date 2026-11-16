import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export const macOSAppLanguage = 'en';

/** Restrict the generated app's UI localizations, leaving framework/input resources intact. */
export function retainEnglishAppResources(resources: string): boolean {
  const entries = readdirSync(resources, { withFileTypes: true });
  if (!entries.some(entry => entry.name === `${macOSAppLanguage}.lproj` && entry.isDirectory())) {
    throw new Error('Cannot configure English menus without the app’s en.lproj resources.');
  }
  let changed = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lproj') || entry.name === `${macOSAppLanguage}.lproj`) continue;
    rmSync(path.join(resources, entry.name), { recursive: true });
    changed = true;
  }
  return changed;
}
