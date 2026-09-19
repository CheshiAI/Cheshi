import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('root and engine test entrypoints isolate inherited app storage, including CLI children', () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'cheshi-storage-isolation-'));
  const userData = path.join(fixtureRoot, 'real-app-data');
  mkdirSync(userData);
  const original = JSON.stringify({ version: 1, currentWorkspaceId: null, workspaces: [] });
  writeFileSync(path.join(userData, 'workspaces.json'), original);
  const testPath = path.join(fixtureRoot, 'storage-fixture.test.ts');
  const environmentModule = new URL('../src/bin/cheshi-environment.ts', import.meta.url).href;
  const directoryModule = new URL('../src/directory.ts', import.meta.url).href;
  const cliSource = `
    import { configureCheshiCodeGraphEnvironment } from ${JSON.stringify(environmentModule)};
    import { createDirectory, getCodeGraphDir } from ${JSON.stringify(directoryModule)};
    configureCheshiCodeGraphEnvironment();
    createDirectory(process.argv[1]);
    console.log(JSON.stringify({ dataRoot: process.env.CODEGRAPH_DATA_ROOT, index: getCodeGraphDir(process.argv[1]) }));
  `;
  writeFileSync(testPath, `
    import { expect, test } from 'bun:test';
    import { spawnSync } from 'node:child_process';
    import { mkdirSync, existsSync } from 'node:fs';
    import path from 'node:path';
    test('isolated storage', () => {
      expect(process.env.CODEGRAPH_DATA_ROOT).toBeUndefined();
      const dataRoot = process.env.CHESHI_USER_DATA_DIR;
      expect(typeof dataRoot).toBe('string');
      expect(dataRoot).not.toBe(${JSON.stringify(userData)});
      const project = path.join(dataRoot, 'project');
      mkdirSync(project);
      const child = spawnSync(process.execPath, ['--eval', ${JSON.stringify(cliSource)}, project], { encoding: 'utf8', env: process.env });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.dataRoot).toBe(dataRoot);
      expect(result.index.startsWith(path.join(dataRoot, 'workspaces') + path.sep)).toBe(true);
      expect(existsSync(path.join(dataRoot, 'workspaces.json'))).toBe(false);
      console.log('ISOLATED_ROOT=' + dataRoot);
    });
  `);
  try {
    for (const cwd of [repositoryRoot, path.join(repositoryRoot, 'codegraph')]) {
      const result = spawnSync(process.execPath, ['test', testPath], {
        cwd, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, CODEGRAPH_DATA_ROOT: userData, CHESHI_USER_DATA_DIR: userData },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const isolatedRoot = /ISOLATED_ROOT=(.+)/.exec(result.stdout)?.[1]?.trim();
      expect(isolatedRoot).toBeDefined();
      expect(existsSync(isolatedRoot!)).toBe(false);
      expect(readFileSync(path.join(userData, 'workspaces.json'), 'utf8')).toBe(original);
      expect(readdirSync(userData)).toEqual(['workspaces.json']);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}, 35_000);
