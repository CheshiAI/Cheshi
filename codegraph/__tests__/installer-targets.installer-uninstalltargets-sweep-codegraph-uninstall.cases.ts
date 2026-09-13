import { uninstallTargets } from '../src/installer';
import { ALL_TARGETS, getTarget, resolveTargetFlag } from '../src/installer/targets/registry';
import { mkTmpDir, setHome } from './installer-targets.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';

export function registerInstallerUninstalltargetsSweepCodegraphUninstallTests(): void {


  describe('Installer — uninstallTargets sweep (codegraph uninstall)', () => {
    let tmpHome: string;
    let tmpCwd: string;
    let origCwd: string;
    let homeRestore: { restore: () => void };

    beforeEach(() => {
      tmpHome = mkTmpDir('un-home');
      tmpCwd = mkTmpDir('un-cwd');
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

    it('sweeps every agent it was installed on and reports removed for each (global)', () => {
      for (const t of ALL_TARGETS) {
        if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
      }

      const reports = uninstallTargets(ALL_TARGETS, 'global');

      for (const t of ALL_TARGETS) {
        const r = reports.find((x) => x.id === t.id)!;
        expect(r.status).toBe('removed');
        expect(r.removedPaths.length).toBeGreaterThan(0);
        // The actual config is gone afterward.
        expect(t.detect('global').alreadyConfigured).toBe(false);
      }
    });

    it('is safe on a clean slate — every agent reports not-configured, nothing removed', () => {
      const reports = uninstallTargets(ALL_TARGETS, 'global');
      for (const r of reports) {
        expect(r.status).toBe('not-configured');
        expect(r.removedPaths).toEqual([]);
      }
    });

    it('reports removed only for agents that were actually configured', () => {
      // Install on Claude only; the rest stay untouched.
      getTarget('claude')!.install('global', { autoAllow: true });

      const reports = uninstallTargets(ALL_TARGETS, 'global');

      const claude = reports.find((r) => r.id === 'claude')!;
      expect(claude.status).toBe('removed');
      expect(claude.displayName).toBe(getTarget('claude')!.displayName);

      for (const r of reports.filter((x) => x.id !== 'claude')) {
        expect(r.status).toBe('not-configured');
      }
    });

    it('marks global-only agents as unsupported for a local sweep (and never touches them)', () => {
      const reports = uninstallTargets(ALL_TARGETS, 'local');
      for (const t of ALL_TARGETS) {
        const r = reports.find((x) => x.id === t.id)!;
        if (t.supportsLocation('local')) {
          expect(r.status).toBe('not-configured');
        } else {
          expect(r.status).toBe('unsupported');
          expect(r.removedPaths).toEqual([]);
          expect(r.notes[0]).toMatch(/global-only/);
        }
      }
    });

    it('is idempotent — a second sweep finds nothing left to remove', () => {
      for (const t of ALL_TARGETS) {
        if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
      }
      const first = uninstallTargets(ALL_TARGETS, 'global');
      expect(first.some((r) => r.status === 'removed')).toBe(true);

      const second = uninstallTargets(ALL_TARGETS, 'global');
      for (const r of second) {
        expect(r.status).toBe('not-configured');
        expect(r.removedPaths).toEqual([]);
      }
    });

    it('a --target subset removes only the chosen agents, leaving siblings configured', () => {
      getTarget('claude')!.install('global', { autoAllow: true });
      getTarget('cursor')!.install('global', { autoAllow: true });

      const reports = uninstallTargets(resolveTargetFlag('claude', 'global'), 'global');

      expect(reports.map((r) => r.id)).toEqual(['claude']);
      expect(reports[0].status).toBe('removed');
      // Cursor was not in the subset — still configured.
      expect(getTarget('cursor')!.detect('global').alreadyConfigured).toBe(true);
      expect(getTarget('claude')!.detect('global').alreadyConfigured).toBe(false);
    });
  });
}
