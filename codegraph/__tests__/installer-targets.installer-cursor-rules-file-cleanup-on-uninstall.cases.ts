import { getTarget } from '../src/installer/targets/registry';
import { LEGACY_BLOCK, mkTmpDir, setHome } from './installer-targets.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerInstallerCursorRulesFileCleanupOnUninstallTests(): void {


  describe('Installer — Cursor rules file cleanup on uninstall', () => {
    let tmpHome: string;
    let tmpCwd: string;
    let origCwd: string;
    let homeRestore: { restore: () => void };
    const cursor = getTarget('cursor')!;

    beforeEach(() => {
      tmpHome = mkTmpDir('cur-home');
      tmpCwd = mkTmpDir('cur-cwd');
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

    const rulesFile = () => path.join(process.cwd(), '.cursor', 'rules', 'codegraph.mdc');

    // The frontmatter a previous install wrote ahead of the marked block.
    // `removeRulesEntry` recognizes it to decide whether the leftover .mdc
    // is ours-to-delete or carries user content worth keeping.
    const MDC_FRONTMATTER = [
      '---',
      'description: CodeGraph MCP usage guide — when to use which tool',
      'alwaysApply: true',
      '---',
      '',
    ].join('\n');

    function plantLegacyRulesFile(extra = ''): void {
      fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
      fs.writeFileSync(rulesFile(), MDC_FRONTMATTER + LEGACY_BLOCK + '\n' + extra);
    }

    it('uninstall deletes a leftover codegraph.mdc entirely (no orphaned frontmatter left behind)', () => {
      plantLegacyRulesFile();
      expect(fs.existsSync(rulesFile())).toBe(true);

      cursor.uninstall('local');

      // The whole file — frontmatter included — is gone, not just the block.
      expect(fs.existsSync(rulesFile())).toBe(false);
    });

    it('install self-heals a leftover codegraph.mdc (#529)', () => {
      plantLegacyRulesFile();
      const result = cursor.install('local', { autoAllow: true });
      expect(fs.existsSync(rulesFile())).toBe(false);
      expect(result.files.some((f) => f.path.endsWith('codegraph.mdc') && f.action === 'removed')).toBe(true);
    });

    it('uninstall preserves user content added outside the codegraph markers (strips only our block)', () => {
      plantLegacyRulesFile('## My own rule\nkeep me\n');

      cursor.uninstall('local');

      expect(fs.existsSync(rulesFile())).toBe(true);
      const after = fs.readFileSync(rulesFile(), 'utf-8');
      expect(after).toContain('keep me');
      // Our tool-usage block is gone.
      expect(after).not.toContain('codegraph_search');
      expect(after).not.toContain('CODEGRAPH_START');
    });
  });
}
