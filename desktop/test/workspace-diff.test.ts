import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { getWorkspaceDiff, parseUnifiedDiff } from '@cheshi/codegraph-server/workspace-diff';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function commit(cwd: string, message: string): void {
  git(cwd, '-c', 'user.email=cheshi@example.invalid', '-c', 'user.name=Cheshi', 'commit', '-qm', message);
}

describe('workspace diff service', () => {
  it('tracks old and new line numbers across mixed hunks', () => {
    const files = parseUnifiedDiff([
      'diff --git a/app.ts b/app.ts',
      'index 1111111..2222222 100644',
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1,5 +1,6 @@ function app',
      ' context',
      '-removed',
      '+added',
      ' context after',
      '+another',
      '\\ No newline at end of file',
      '',
    ].join('\n'));

    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe('modified');
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
    expect(files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 1, 1],
      ['remove', 2, null],
      ['add', null, 2],
      ['context', 3, 3],
      ['add', null, 4],
    ]);
  });

  it('combines tracked diffs with safe untracked text files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshire-diff-'));
    try {
      fs.writeFileSync(path.join(root, 'app.ts'), 'const value = 1;\n', 'utf8');
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      commit(root, 'initial');

      fs.writeFileSync(path.join(root, 'app.ts'), 'const value = 2;\nconst next = value + 1;\n', 'utf8');
      fs.writeFileSync(path.join(root, 'new.ts'), 'export const fresh = true;\n', 'utf8');

      const result = await getWorkspaceDiff(root);
      expect(result.tooLarge).toBe(false);
      expect(result.mode).toBe('uncommitted');
      expect(result.files.map((file) => file.path)).toEqual(['app.ts', 'new.ts']);
      expect(result.files.find((file) => file.path === 'app.ts')?.status).toBe('modified');
      const untracked = result.files.find((file) => file.path === 'new.ts');
      expect(untracked?.status).toBe('added');
      expect(untracked?.additions).toBe(1);
      expect(untracked?.hunks[0]?.lines[0]?.newLine).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
