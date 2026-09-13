import { scanDirectory } from '../src/extraction';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerGitSubmodulesTests(): void {


  describe('Git Submodules', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should index files inside git submodules (issue #147)', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, stdio: 'pipe' });

      // Build a separate "library" repo to use as a submodule source.
      const libDir = path.join(tempDir, '_lib');
      fs.mkdirSync(libDir, { recursive: true });
      git(libDir, 'init', '-q');
      git(libDir, 'config', 'user.email', 'test@test.com');
      git(libDir, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(libDir, 'lib.ts'), 'export const fromSubmodule = 1;');
      git(libDir, 'add', '-A');
      git(libDir, 'commit', '-q', '-m', 'lib init');

      // Build the main repo and add the lib repo as a submodule.
      const mainDir = path.join(tempDir, 'main');
      fs.mkdirSync(mainDir, { recursive: true });
      git(mainDir, 'init', '-q');
      git(mainDir, 'config', 'user.email', 'test@test.com');
      git(mainDir, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(mainDir, 'app.ts'), 'export const app = 1;');
      git(mainDir, 'add', '-A');
      git(mainDir, 'commit', '-q', '-m', 'app init');
      // protocol.file.allow=always is required to add a local-path submodule on
      // recent git versions (CVE-2022-39253 mitigation).
      execFileSync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', libDir, 'libs/lib'],
        { cwd: mainDir, stdio: 'pipe' }
      );
      git(mainDir, 'commit', '-q', '-m', 'add submodule');

      const files = scanDirectory(mainDir);

      expect(files).toContain('app.ts');
      expect(files).toContain('libs/lib/lib.ts');
    });
  });
}
