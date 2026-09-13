import { getTarget } from '../src/installer/targets/registry';
import { LEGACY_BLOCK, mkTmpDir, setHome } from './installer-targets.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerInstallerTargetsOpencodeXdgConfigPath535Tests(): void {


  // ---------------------------------------------------------------------------
  // opencode global config path — XDG on every platform (#535)
  //
  // opencode resolves its config dir with `xdg-basedir`: XDG_CONFIG_HOME if
  // set, else ~/.config — on ALL platforms, Windows included. It never reads
  // %APPDATA%; we used to write there on Windows, so opencode never saw the
  // entry. The suite-wide setHome() points APPDATA and XDG_CONFIG_HOME at the
  // SAME directory (which is exactly how this bug stayed invisible), so these
  // tests deliberately split them.
  // ---------------------------------------------------------------------------
  describe('Installer targets — opencode XDG config path (#535)', () => {
    let tmpHome: string;
    let tmpCwd: string;
    let origCwd: string;
    let homeRestore: { restore: () => void };
    let appDataDir: string; // distinct from ~/.config, like real Windows

    beforeEach(() => {
      tmpHome = mkTmpDir('home');
      tmpCwd = mkTmpDir('cwd');
      origCwd = process.cwd();
      process.chdir(tmpCwd);
      homeRestore = setHome(tmpHome);
      appDataDir = path.join(tmpHome, 'AppData', 'Roaming');
      process.env.APPDATA = appDataDir; // realistic split: APPDATA ≠ ~/.config
      delete process.env.XDG_CONFIG_HOME; // default resolution: ~/.config
    });

    afterEach(() => {
      homeRestore.restore();
      process.chdir(origCwd);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    });

    const xdgConfigFile = () => path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc');
    const legacyDir = () => path.join(appDataDir, 'opencode');
    // NOTE: never match on an 'AppData' substring — on Windows os.tmpdir()
    // itself lives under AppData\Local\Temp, so EVERY harness path contains
    // it. Match on the legacy dir prefix instead.
    const inLegacyDir = (p: string) => path.resolve(p).startsWith(path.resolve(legacyDir()) + path.sep);

    it('global install writes to ~/.config/opencode, never %APPDATA% (#535)', () => {
      const opencode = getTarget('opencode')!;
      const result = opencode.install('global', { autoAllow: true });

      const written = result.files.find((f) => f.path.endsWith('opencode.jsonc'))!;
      expect(written.action).toBe('created');
      expect(path.resolve(written.path)).toBe(path.resolve(xdgConfigFile()));
      expect(fs.existsSync(xdgConfigFile())).toBe(true);
      // Nothing of ours may land in the legacy location.
      expect(fs.existsSync(legacyDir())).toBe(false);
    });

    it('greenfield: targets ~/.config/opencode even when the dir does not exist yet (#535)', () => {
      // The rejected fallback design (#670) would send this install to
      // %APPDATA% — where opencode would never find it. opencode creates
      // ~/.config/opencode itself on first run; installing codegraph FIRST
      // must land where opencode will look.
      expect(fs.existsSync(path.join(tmpHome, '.config', 'opencode'))).toBe(false);
      const opencode = getTarget('opencode')!;
      const result = opencode.install('global', { autoAllow: true });
      expect(path.resolve(result.files[0]!.path)).toBe(path.resolve(xdgConfigFile()));
      expect(fs.existsSync(xdgConfigFile())).toBe(true);
      expect(fs.existsSync(legacyDir())).toBe(false);
    });

    it('honors XDG_CONFIG_HOME for the global path, like opencode does', () => {
      const custom = path.join(tmpHome, 'xdg-custom');
      process.env.XDG_CONFIG_HOME = custom;
      const opencode = getTarget('opencode')!;
      const result = opencode.install('global', { autoAllow: true });
      expect(path.resolve(result.files[0]!.path))
        .toBe(path.resolve(path.join(custom, 'opencode', 'opencode.jsonc')));
    });

    it('install self-heals a pre-#535 %APPDATA% entry, preserving siblings and comments', () => {
      // A previous codegraph version wrote into %APPDATA%/opencode. The user
      // also has another MCP server and a comment there — those must survive.
      fs.mkdirSync(legacyDir(), { recursive: true });
      fs.writeFileSync(path.join(legacyDir(), 'opencode.jsonc'), [
        '{',
        '  // my servers',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "mcp": {',
        '    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true },',
        '    "other": { "type": "local", "command": ["other"], "enabled": true }',
        '  }',
        '}',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(legacyDir(), 'AGENTS.md'), LEGACY_BLOCK + '\n');

      const opencode = getTarget('opencode')!;
      const result = opencode.install('global', { autoAllow: true });

      // New entry in the right place…
      expect(fs.existsSync(xdgConfigFile())).toBe(true);
      // …stale entry swept out of the legacy file, siblings + comment intact.
      const legacyText = fs.readFileSync(path.join(legacyDir(), 'opencode.jsonc'), 'utf-8');
      expect(legacyText).not.toContain('codegraph');
      expect(legacyText).toContain('"other"');
      expect(legacyText).toContain('// my servers');
      // …and the legacy AGENTS.md — block-only, so emptied — removed outright
      // (removeMarkedSection unlinks a file it leaves empty).
      expect(fs.existsSync(path.join(legacyDir(), 'AGENTS.md'))).toBe(false);
      // Both cleanups are reported.
      const removed = result.files.filter((f) => f.action === 'removed').map((f) => f.path);
      expect(removed.some((p) => inLegacyDir(p) && p.endsWith('opencode.jsonc'))).toBe(true);
      expect(removed.some((p) => inLegacyDir(p) && p.endsWith('AGENTS.md'))).toBe(true);
    });

    it('uninstall sweeps the legacy %APPDATA% entry too (no prior re-install needed)', () => {
      // A user on the broken version goes straight to `codegraph uninstall`:
      // the only entry that exists is the stale %APPDATA% one.
      fs.mkdirSync(legacyDir(), { recursive: true });
      fs.writeFileSync(path.join(legacyDir(), 'opencode.json'),
        '{\n  "mcp": {\n    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true }\n  }\n}\n');

      const opencode = getTarget('opencode')!;
      const result = opencode.uninstall('global');

      expect(fs.readFileSync(path.join(legacyDir(), 'opencode.json'), 'utf-8')).not.toContain('codegraph');
      expect(result.files.some((f) => f.action === 'removed' && inLegacyDir(f.path))).toBe(true);
    });

    it('install after install sweeps only once — second run reports no legacy changes', () => {
      fs.mkdirSync(legacyDir(), { recursive: true });
      fs.writeFileSync(path.join(legacyDir(), 'opencode.json'),
        '{\n  "mcp": {\n    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true }\n  }\n}\n');

      const opencode = getTarget('opencode')!;
      const first = opencode.install('global', { autoAllow: true });
      expect(first.files.some((f) => f.action === 'removed' && inLegacyDir(f.path))).toBe(true);

      const second = opencode.install('global', { autoAllow: true });
      expect(second.files.some((f) => inLegacyDir(f.path))).toBe(false);
      expect(second.files.find((f) => f.path.endsWith('opencode.jsonc'))!.action).toBe('unchanged');
    });

    it('detects opencode as installed from a legacy-only %APPDATA% dir (so install can heal it)', () => {
      fs.mkdirSync(legacyDir(), { recursive: true });
      const opencode = getTarget('opencode')!;
      expect(opencode.detect('global').installed).toBe(true);
      // But configuration state is read from the REAL path only.
      expect(opencode.detect('global').alreadyConfigured).toBe(false);
    });
  });
}
