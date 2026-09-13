import { buildScopeIgnore, discoverEmbeddedRepoRoots, scanDirectory } from '../src/extraction';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerNestedGitlinkRepos10311033Tests(): void {


  describe('Nested gitlink repos (#1031, #1033)', () => {
    let tempDir: string;
    // Helper: make a self-contained git repo at `dir` with one committed TS file.
    const makeRepo = async (dir: string, base: string) => {
      const { execFileSync } = await import('child_process');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      fs.mkdirSync(dir, { recursive: true });
      git('init', '-q');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(dir, `${base}.ts`), `export const ${base} = 1;`);
      git('add', '-A');
      git('commit', '-q', '-m', `${base} init`);
    };

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    // The #1031 case: a nested repo `git add`ed inside the super-repo becomes a
    // gitlink (mode 160000) with NO `.gitmodules`. It is tracked (so it never shows
    // in the untracked `-o` listing) yet not an active submodule (so
    // `--recurse-submodules` won't expand it) — it used to fall through both passes
    // and only the super-repo's own files got indexed.
    it('indexes a bare gitlink (git add\'ed embedded repo, no .gitmodules), recursively', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

      const root = path.join(tempDir, 'root');
      await makeRepo(root, 'app');

      // An embedded clone, itself holding a further nested clone (untracked inside it).
      await makeRepo(path.join(root, 'embedded'), 'inner');
      await makeRepo(path.join(root, 'embedded', 'deep'), 'deep');

      // `git add embedded` records it as a 160000 gitlink (no fetch, no .gitmodules).
      git(root, 'add', 'embedded');
      git(root, 'commit', '-q', '-m', 'add embedded as gitlink');
      expect(fs.existsSync(path.join(root, '.gitmodules'))).toBe(false);

      const files = scanDirectory(root);

      expect(files).toContain('app.ts');
      expect(files).toContain('embedded/inner.ts'); // the gitlink's own source
      expect(files).toContain('embedded/deep/deep.ts'); // recursion continues into its nested repo
    });

    // The -c → -s switch must not regress active submodules (#147): a repo can hold
    // BOTH an active submodule (expanded by --recurse-submodules) and a bare gitlink
    // (handled by the new pass), and the mixed 160000/100644 modes must parse right.
    it('indexes a gitlink alongside an active submodule', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

      const lib = path.join(tempDir, '_lib');
      await makeRepo(lib, 'lib');

      const root = path.join(tempDir, 'root');
      await makeRepo(root, 'app');

      // A proper, active submodule.
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libs/lib'], { cwd: root, stdio: 'pipe' });
      git(root, 'commit', '-q', '-m', 'add submodule');

      // A bare gitlink in the same repo (under a non-ignored dir name).
      await makeRepo(path.join(root, 'external', 'tool'), 'tool');
      git(root, 'add', 'external/tool');
      git(root, 'commit', '-q', '-m', 'add gitlink');

      const files = scanDirectory(root);

      expect(files).toContain('app.ts');
      expect(files).toContain('libs/lib/lib.ts'); // active submodule still expands (#147)
      expect(files).toContain('external/tool/tool.ts'); // bare gitlink now indexed
    });

    // A gitlink under a built-in default-ignored directory (vendor/, node_modules/,
    // …) stays excluded — a committed dependency doesn't become project code just
    // because it's a nested repo. Mirrors how the untracked-embedded path treats
    // the same dirs (#407), so the two passes agree.
    it('does not index a gitlink under a default-ignored directory (e.g. vendor/)', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

      const root = path.join(tempDir, 'root');
      await makeRepo(root, 'app');
      await makeRepo(path.join(root, 'vendor', 'pkg'), 'dep');
      git(root, 'add', 'vendor/pkg');
      git(root, 'commit', '-q', '-m', 'add vendored gitlink');

      const files = scanDirectory(root);

      expect(files).toContain('app.ts');
      expect(files).not.toContain('vendor/pkg/dep.ts');
    });

    // A gitlink with NO working tree on disk (the common "cloned without
    // --recurse-submodules" state) has nothing to index — we must leave it alone,
    // not fabricate entries, and must not break the rest of the scan.
    it('leaves an uninitialized submodule (no checkout on disk) alone', async () => {
      const { execFileSync } = await import('child_process');

      const lib = path.join(tempDir, '_lib');
      await makeRepo(lib, 'lib');

      const sup = path.join(tempDir, 'super');
      await makeRepo(sup, 'app');
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libs/lib'], { cwd: sup, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', 'add submodule'], { cwd: sup, stdio: 'pipe' });

      // Clone the super-repo WITHOUT --recurse-submodules → libs/lib is an empty
      // gitlink dir (mode 160000, no `.git` inside, no files).
      const clone = path.join(tempDir, 'clone');
      execFileSync('git', ['clone', '-q', sup, clone], { stdio: 'pipe' });
      expect(fs.readdirSync(path.join(clone, 'libs', 'lib'))).toHaveLength(0);

      const files = scanDirectory(clone);

      expect(files).toContain('app.ts');
      expect(files).not.toContain('libs/lib/lib.ts'); // not on disk → correctly absent
    });

    // #1065: a gitlink under a path the super-repo's OWN `.gitignore` covers is the
    // tracked-gitlink twin of the untracked-ignored embedded repo (#514, #970). The
    // gitlink-discovery pass must honor that `.gitignore` the same way — otherwise a
    // gitignored reference/benchmark corpus full of `git add`ed clones gets pulled
    // into the index (the 138k-file blow-up the reporter hit). Respect it by default;
    // re-include only via `codegraph.json` `includeIgnored`.
    it('does not index a gitlink under a gitignored directory by default (#1065)', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

      const root = path.join(tempDir, 'root');
      await makeRepo(root, 'app');
      // An embedded clone under a path the super-repo gitignores (a benchmark corpus).
      await makeRepo(path.join(root, 'benchmark', 'repos', 'ref'), 'ref');
      git(root, 'add', 'benchmark/repos/ref'); // tracked as a 160000 gitlink
      fs.writeFileSync(path.join(root, '.gitignore'), 'benchmark/repos/\n');
      git(root, 'add', '.gitignore');
      git(root, 'commit', '-q', '-m', 'add gitignored gitlink + ignore rule');

      const files = scanDirectory(root);
      expect(files).toContain('app.ts');
      expect(files).not.toContain('benchmark/repos/ref/ref.ts'); // gitignored → excluded

      // The watcher path agrees: the ignored root is never discovered, and the dir is
      // pruned (the reporter's exact clue — `ignores('benchmark/repos/')` was false).
      expect(discoverEmbeddedRepoRoots(root)).toEqual([]);
      expect(buildScopeIgnore(root).ignores('benchmark/repos/')).toBe(true);
      expect(buildScopeIgnore(root).ignores('benchmark/repos/ref/ref.ts')).toBe(true);
    });

    it('re-includes a gitignored gitlink when codegraph.json includeIgnored opts in (#1065)', async () => {
      const { execFileSync } = await import('child_process');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

      const root = path.join(tempDir, 'root');
      await makeRepo(root, 'app');
      await makeRepo(path.join(root, 'benchmark', 'repos', 'ref'), 'ref');
      git(root, 'add', 'benchmark/repos/ref');
      fs.writeFileSync(path.join(root, '.gitignore'), 'benchmark/repos/\n');
      fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ includeIgnored: ['benchmark/repos/'] }));
      git(root, 'add', '.gitignore', 'codegraph.json');
      git(root, 'commit', '-q', '-m', 'opt the gitignored gitlink back in');

      const files = scanDirectory(root);
      expect(files).toContain('app.ts');
      expect(files).toContain('benchmark/repos/ref/ref.ts'); // opted in → indexed
      expect(discoverEmbeddedRepoRoots(root)).toContain('benchmark/repos/ref/');
    });
  });
}
