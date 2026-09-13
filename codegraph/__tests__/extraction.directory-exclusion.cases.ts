import { scanDirectory } from '../src/extraction';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerDirectoryExclusionTests(): void {


  describe('Directory Exclusion', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should exclude directories listed in .gitignore', () => {
      // Create structure: src/index.ts + node_modules/pkg/index.js, gitignore node_modules
      const srcDir = path.join(tempDir, 'src');
      const nmDir = path.join(tempDir, 'node_modules', 'pkg');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(nmDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');

      const files = scanDirectory(tempDir);

      expect(files).toContain('src/index.ts');
      expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
    });

    it('should exclude nested node_modules via a root .gitignore', () => {
      // A trailing-slash pattern with no leading slash matches at any depth.
      const srcDir = path.join(tempDir, 'packages', 'app', 'src');
      const nmDir = path.join(tempDir, 'packages', 'app', 'node_modules', 'pkg');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(nmDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');

      const files = scanDirectory(tempDir);

      expect(files).toContain('packages/app/src/index.ts');
      expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
    });

    it('should apply a nested .gitignore only to its own subtree', () => {
      const appSrc = path.join(tempDir, 'app', 'src');
      fs.mkdirSync(appSrc, { recursive: true });
      fs.writeFileSync(path.join(appSrc, 'keep.ts'), 'export const a = 1;');
      fs.writeFileSync(path.join(appSrc, 'skip.ts'), 'export const b = 2;');
      fs.writeFileSync(path.join(tempDir, 'app', '.gitignore'), 'src/skip.ts\n');
      // A sibling with the same name outside app/ must NOT be ignored.
      const otherDir = path.join(tempDir, 'other', 'src');
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(path.join(otherDir, 'skip.ts'), 'export const c = 3;');

      const files = scanDirectory(tempDir);

      expect(files).toContain('app/src/keep.ts');
      expect(files).not.toContain('app/src/skip.ts');
      expect(files).toContain('other/src/skip.ts');
    });

    it('should always skip .git directories', () => {
      const srcDir = path.join(tempDir, 'src');
      const gitDir = path.join(tempDir, '.git', 'objects');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
      fs.writeFileSync(path.join(gitDir, 'pack.ts'), 'export const y = 2;');

      const files = scanDirectory(tempDir);

      expect(files).toContain('src/index.ts');
      expect(files.every((f) => !f.includes('.git'))).toBe(true);
    });

    it('should return forward-slash paths on all platforms', () => {
      const srcDir = path.join(tempDir, 'src', 'components');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'Button.tsx'), 'export function Button() {}');

      const files = scanDirectory(tempDir);

      expect(files.length).toBe(1);
      expect(files[0]).toBe('src/components/Button.tsx');
      expect(files[0]).not.toContain('\\');
    });
  });
}
