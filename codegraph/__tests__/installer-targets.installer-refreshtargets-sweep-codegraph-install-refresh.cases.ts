import { refreshTargets } from '../src/installer';
import { ALL_TARGETS, getTarget } from '../src/installer/targets/registry';
import { LEGACY_BLOCK, mkTmpDir, setHome } from './installer-targets.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerInstallerRefreshtargetsSweepCodegraphInstallRefreshTests(): void {


  describe('Installer — refreshTargets sweep (codegraph install --refresh)', () => {
    let tmpHome: string;
    let tmpCwd: string;
    let origCwd: string;
    let homeRestore: { restore: () => void };

    beforeEach(() => {
      tmpHome = mkTmpDir('rf-home');
      tmpCwd = mkTmpDir('rf-cwd');
      origCwd = process.cwd();
      process.chdir(tmpCwd);
      homeRestore = setHome(tmpHome);
    });

    afterEach(() => {
      homeRestore.restore();
      process.chdir(origCwd);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    });

    it('rewrites a stale instructions block a previous version left, and reports refreshed', () => {
      const claude = getTarget('claude')!;
      claude.install('global', { autoAllow: true });

      // Simulate the file as an old install left it: same markers, the old
      // multi-tool wording.
      const claudeMd = path.join(tmpHome, '.claude', 'CLAUDE.md');
      fs.writeFileSync(claudeMd, LEGACY_BLOCK + '\n');

      const reports = refreshTargets([claude], 'global');
      expect(reports[0].status).toBe('refreshed');
      expect(reports[0].changedPaths).toContain(claudeMd);

      const md = fs.readFileSync(claudeMd, 'utf-8');
      expect(md).not.toContain('codegraph_search');
      expect(md).toContain('codegraph_explore');
    });

    it('never performs a first install — unconfigured agents stay untouched', () => {
      const reports = refreshTargets(ALL_TARGETS, 'global');
      for (const t of ALL_TARGETS) {
        const r = reports.find((x) => x.id === t.id)!;
        expect(r.status).toBe(t.supportsLocation('global') ? 'not-configured' : 'unsupported');
        expect(r.changedPaths).toEqual([]);
        expect(t.detect('global').alreadyConfigured).toBe(false);
      }
    });

    it('preserves the user\'s permission choices (refresh never writes permissions)', () => {
      const claude = getTarget('claude')!;
      claude.install('global', { autoAllow: true });

      // The user has since trimmed the allowlist by hand.
      const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      settings.permissions.allow = [];
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

      refreshTargets([claude], 'global');

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(after.permissions.allow).toEqual([]);
    });

    it('is idempotent — a second sweep on a current machine reports unchanged everywhere', () => {
      for (const t of ALL_TARGETS) {
        if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
      }
      const first = refreshTargets(ALL_TARGETS, 'global');
      // Fresh installs are already current, so even the first sweep may be
      // all-unchanged; what matters is the second definitely is.
      const second = refreshTargets(ALL_TARGETS, 'global');
      for (const r of [...first, ...second]) {
        expect(['unchanged', 'refreshed']).toContain(r.status);
      }
      for (const r of second) {
        expect(r.status).toBe('unchanged');
        expect(r.changedPaths).toEqual([]);
      }
    });
  });
}
