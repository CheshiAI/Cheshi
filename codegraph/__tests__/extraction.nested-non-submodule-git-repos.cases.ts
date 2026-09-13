import { buildDefaultIgnore, scanDirectory } from '../src/extraction';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerNestedNonSubmoduleGitReposTests(): void {


  describe('Nested non-submodule git repos', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should index files in embedded git repos run from a git super-repo (issue #193)', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, stdio: 'pipe' });

      // Top-level workspace is itself a git repo, holding no source directly —
      // the CMake "super-repo" layout from the issue.
      const root = path.join(tempDir, 'root');
      fs.mkdirSync(path.join(root, 'coding'), { recursive: true });
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'test@test.com');
      git(root, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n');

      // Two independent clones living inside the workspace (NOT submodules):
      // one with committed source, one with only untracked source.
      const sub1 = path.join(root, 'sub_repo1', 'src');
      fs.mkdirSync(sub1, { recursive: true });
      git(path.join(root, 'sub_repo1'), 'init', '-q');
      git(path.join(root, 'sub_repo1'), 'config', 'user.email', 'test@test.com');
      git(path.join(root, 'sub_repo1'), 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(sub1, 'one.ts'), 'export const one = 1;');
      git(path.join(root, 'sub_repo1'), 'add', '-A');
      git(path.join(root, 'sub_repo1'), 'commit', '-q', '-m', 'sub1 init');

      const sub2 = path.join(root, 'sub_repo2', 'src');
      fs.mkdirSync(sub2, { recursive: true });
      git(path.join(root, 'sub_repo2'), 'init', '-q');
      fs.writeFileSync(path.join(sub2, 'two.ts'), 'export const two = 2;');

      const files = scanDirectory(root);

      // Both committed and untracked source from the nested repos must be found.
      expect(files).toContain('sub_repo1/src/one.ts');
      expect(files).toContain('sub_repo2/src/two.ts');
    });

    it('should respect each embedded repo\'s own .gitignore', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, stdio: 'pipe' });

      const root = path.join(tempDir, 'root');
      fs.mkdirSync(root, { recursive: true });
      git(root, 'init', '-q');

      const sub = path.join(root, 'sub_repo', 'src');
      fs.mkdirSync(sub, { recursive: true });
      git(path.join(root, 'sub_repo'), 'init', '-q');
      fs.writeFileSync(path.join(root, 'sub_repo', '.gitignore'), 'src/generated.ts\n');
      fs.writeFileSync(path.join(sub, 'real.ts'), 'export const real = 1;');
      fs.writeFileSync(path.join(sub, 'generated.ts'), 'export const generated = 1;');

      const files = scanDirectory(root);

      expect(files).toContain('sub_repo/src/real.ts');
      expect(files).not.toContain('sub_repo/src/generated.ts');
    });

    // A .gitignore the `ignore` library can't compile to a regex must not abort
    // the whole scan — the bad pattern is dropped, valid ones still apply (#682).
    it('does not crash on a .gitignore with an uncompilable pattern (#682)', () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'real.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(tempDir, 'build', 'out.ts'), 'export const y = 2;');
      // `\\[` makes the matcher build an unterminated character class — the throw
      // is lazy (at match time), which is what escaped and killed sync.
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n\\\\[\n');

      let files: string[] = [];
      expect(() => {
        files = scanDirectory(tempDir);
      }).not.toThrow();
      expect(files).toContain('src/real.ts');
      // The still-valid `build/` rule is honored; only the bad line was dropped.
      expect(files.some((f) => f.startsWith('build/'))).toBe(false);
    });

    // A .gitignore that isn't valid UTF-8 — e.g. encrypted in place by corporate
    // DLP / endpoint software (UTF-16 header + ciphertext) — is skipped whole,
    // not fed to the matcher as garbage patterns (#682).
    it('does not crash on a non-UTF-8 (DLP-encrypted) .gitignore (#682)', () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'real.ts'), 'export const x = 1;');
      const header = Buffer.concat([
        Buffer.from([0x00, 0x00]),
        Buffer.from('[notice][user]', 'utf16le'),
      ]);
      const junk = Buffer.from([0x5b, 0x99, 0xc3, 0x28, 0x5c, 0x5b, 0xff, 0xfd]);
      fs.writeFileSync(path.join(tempDir, '.gitignore'), Buffer.concat([header, junk]));

      let files: string[] = [];
      expect(() => {
        files = scanDirectory(tempDir);
      }).not.toThrow();
      expect(files).toContain('src/real.ts');
    });

    it('buildDefaultIgnore survives a bad .gitignore and still applies valid rules (#682)', () => {
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'dist/\n\\\\[\n');
      const ig = buildDefaultIgnore(tempDir);
      expect(() => ig.ignores('src/app.ts')).not.toThrow();
      expect(ig.ignores('dist/')).toBe(true); // valid rule survives
      expect(ig.ignores('src/app.ts')).toBe(false);
    });
  });
}
