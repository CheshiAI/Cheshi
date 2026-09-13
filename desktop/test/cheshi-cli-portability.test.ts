import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRuntime = process.env.CHESHI_TEST_RUNTIME_DIR
  ?? path.join(repositoryRoot, 'desktop', 'runtime', `${process.platform}-${process.arch}`);

// Run after desktop:runtime. The filesystem denial reproduces a clean Mac that
// does not have the checkout used to compile the Bun executable.
test('relocated CodeGraph runtime indexes without access to its source checkout', {
  skip: process.platform !== 'darwin' ? 'Requires the macOS sandbox-exec filesystem boundary.' : false,
  timeout: 120_000,
}, () => {
  assert.ok(existsSync(path.join(sourceRuntime, 'cheshi-cli')), 'Build desktop:runtime before this test.');
  const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'cheshi-portability-')));
  const relocatedRuntime = path.join(temporaryRoot, 'runtime');
  const fixture = path.join(temporaryRoot, 'project');
  const dataRoot = path.join(temporaryRoot, 'data');
  const profile = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath ${JSON.stringify(repositoryRoot)}))`,
  ].join('\n');
  const environment: NodeJS.ProcessEnv = {
    ...process.env, NO_COLOR: '1', CODEGRAPH_DATA_ROOT: dataRoot, CHESHI_USER_DATA_DIR: dataRoot,
  };
  // Exercise discovery next to the relocated executable, not development overrides.
  for (const key of ['CODEGRAPH_RUNTIME_ROOT', 'CHESHI_PRODUCT_FILE', 'CODEGRAPH_CLI_LAUNCHER']) {
    delete environment[key];
  }

  const run = (executable: string, args: readonly string[]) => {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], {
      cwd: fixture,
      encoding: 'utf8',
      env: environment,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    return result;
  };
  const cli = (...args: string[]) => {
    const result = run(path.join(relocatedRuntime, 'cheshi-cli'), args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };

  try {
    mkdirSync(relocatedRuntime);
    mkdirSync(fixture);
    for (const resource of ['cheshi-cli', 'codegraph-watchdog', 'workers', 'grammars', 'tree-sitter.wasm', 'schema.sql', '.env.product']) {
      cpSync(path.join(sourceRuntime, resource), path.join(relocatedRuntime, resource), { recursive: true });
    }
    writeFileSync(path.join(fixture, 'greeting.ts'), 'export function portableGreeting(name: string): string { return `Hello ${name}`; }\n');

    const denied = run('/bin/cat', [path.join(repositoryRoot, 'codegraph', 'package.json')]);
    assert.notEqual(denied.status, 0, 'The child must not be able to read the build checkout.');
    assert.match(denied.stderr, /Operation not permitted|Permission denied/);

    assert.match(cli('--version').trim(), /^\d+\.\d+\.\d+/);
    const enginePackage = JSON.parse(readFileSync(path.join(repositoryRoot, 'codegraph', 'package.json'), 'utf8'));
    assert.ok(cli('codegraph', 'version').includes(enginePackage.version));
    cli('codegraph', 'init', fixture);
    const status = JSON.parse(cli('codegraph', 'status', fixture, '--json'));
    assert.equal(status.initialized, true);
    assert.equal(status.index.state, 'complete');
    assert.equal(status.index.pendingRefs, 0);
    assert.equal(status.fileCount, 1);
    assert.ok(status.nodeCount > 0);
    assert.ok(status.indexPath.startsWith(`${dataRoot}${path.sep}`));
    assert.equal(existsSync(path.join(fixture, '.codegraph')), false);
    assert.match(cli('codegraph', 'node', 'portableGreeting', '--path', fixture), /export function portableGreeting/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
