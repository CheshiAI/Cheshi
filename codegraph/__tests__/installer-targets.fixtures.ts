import { spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-targets-${label}-`));
}

// Bun caches os.homedir() independently of process.env mutations made after
// startup. Pin the API itself to the temporary directory so every installer
// target is isolated from the real home, while retaining env overrides for
// targets that intentionally read XDG_CONFIG_HOME, APPDATA, or HERMES_HOME.
export function setHome(dir: string): { restore: () => void } {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HERMES_HOME: process.env.HERMES_HOME,
    CODEGRAPH_DATA_ROOT: process.env.CODEGRAPH_DATA_ROOT,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, '.config');
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  delete process.env.HERMES_HOME;
  delete process.env.CODEGRAPH_DATA_ROOT;
  const homedirSpy = spyOn(os, 'homedir').mockReturnValue(dir);
  return {
    restore() {
      homedirSpy.mockRestore();
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
      if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
      if (prev.HERMES_HOME === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = prev.HERMES_HOME;
      if (prev.CODEGRAPH_DATA_ROOT === undefined) delete process.env.CODEGRAPH_DATA_ROOT;
      else process.env.CODEGRAPH_DATA_ROOT = prev.CODEGRAPH_DATA_ROOT;
    },
  };
}

// A marker-delimited CodeGraph block exactly as a previous installer
// wrote it. Issue #529: the installer no longer writes an instructions
// file, but install (self-heal on upgrade) and uninstall both still
// strip a block a prior install left, so we plant this to exercise it.
export const LEGACY_BLOCK = [
  '<!-- CODEGRAPH_START -->',
  '## CodeGraph',
  '',
  'Prefer `codegraph_search` / `codegraph_callers` over grep.',
  '<!-- CODEGRAPH_END -->',
].join('\n');

export function listAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}
