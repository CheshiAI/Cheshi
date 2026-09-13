import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../..');

// Run mocks in their own process so they cannot replace real engine modules in
// other suites. No index or workspace files are created by this command test.
function runInit(
  initialized: boolean,
  interactive: boolean | undefined,
  options: { success?: boolean; retrySuccess?: boolean; expectedExitCode?: number } = {},
): string[] {
  const script = `
    import { mock } from 'bun:test';
    import { Command } from 'commander';
    const calls = [];
    const results = ${JSON.stringify([
      { success: options.success ?? true, nodesCreated: options.retrySuccess === undefined ? 1 : 0 },
      { success: options.retrySuccess, nodesCreated: 1 },
    ])};
    const noop = () => {};
    const clack = { intro: noop, outro: noop, log: {
      error: noop, warn: noop, info: noop, success: noop,
    } };
    Object.defineProperty(process.stdin, 'isTTY', { value: ${interactive} });
    const runtime = await import('./codegraph/src/bin/cli-runtime');
    mock.module('./codegraph/src/directory', () => ({
      getCodeGraphDir: () => '/unused/index',
      isInitialized: () => ${initialized},
      unsafeIndexRootReason: () => null,
    }));
    mock.module('./codegraph/src/bin/cli-runtime', () => ({
      ...runtime,
      loadClack: async () => clack,
      loadCodeGraph: async () => ({
        default: { init: async () => {
          calls.push('initialize');
          return {
            indexAll: async () => {
              calls.push('index');
              return results.shift();
            },
            close: () => calls.push('close'),
          };
        } },
        getDatabasePath: () => '/unused/index/codegraph.db',
      }),
    }));
    mock.module('./codegraph/src/bin/cli-index-progress', () => ({
      offerIndexIgnoredRepos: async (_clack, _root, reindex) => reindex(),
      printIndexResult: noop,
      runIndexWithProgress: async (_verbose, index) => index({}),
    }));
    mock.module('./codegraph/src/bin/command-supervision', () => ({
      installCommandSupervision: () => ({ stop: noop }),
    }));
    mock.module('./codegraph/src/installer', () => ({
      offerWatchFallback: async () => calls.push('watch prompt'),
    }));
    const { registerIndexCommands } = await import('./codegraph/src/bin/cli-index-commands');
    const program = new Command();
    registerIndexCommands(program, { version: 'test' });
    await program.parseAsync(['init', '/unused/project'], { from: 'user' });
    console.log(JSON.stringify(calls));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.stderr).toBe('');
  expect(result.status).toBe(options.expectedExitCode ?? 0);
  return JSON.parse(result.stdout);
}

describe('init watcher setup prompts', () => {
  it('finishes a first noninteractive index without offering hook installation', () => {
    expect(runInit(false, false)).toEqual(['initialize', 'index', 'close']);
  });

  it('leaves an existing index alone without a noninteractive prompt', () => {
    expect(runInit(true, false)).toEqual([]);
  });

  it('treats a missing isTTY flag as noninteractive', () => {
    expect(runInit(false, undefined)).toEqual(['initialize', 'index', 'close']);
  });

  it('keeps watcher setup available in an interactive first initialization', () => {
    expect(runInit(false, true)).toEqual(['initialize', 'index', 'watch prompt', 'close']);
  });

  it('keeps watcher setup available for an existing index in a terminal', () => {
    expect(runInit(true, true)).toEqual(['watch prompt']);
  });

  it('reports failed first indexing with a nonzero exit status and closes the index', () => {
    expect(runInit(false, false, { success: false, expectedExitCode: 1 }))
      .toEqual(['initialize', 'index', 'close']);
  });

  it('reports a failed ignored repository retry even after a successful first pass', () => {
    expect(runInit(false, true, { retrySuccess: false, expectedExitCode: 1 }))
      .toEqual(['initialize', 'index', 'index', 'close']);
  });

  it('accepts successful ignored repository retry after a failed first pass', () => {
    expect(runInit(false, true, { success: false, retrySuccess: true }))
      .toEqual(['initialize', 'index', 'index', 'watch prompt', 'close']);
  });
});
