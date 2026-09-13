import { describe, expect, test } from 'bun:test';
import { deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodeGraphIndexer, CodeGraphService, createCodeGraphCommands } from '../lib/codegraph-service.mts';

type CodeGraphLogger = ConstructorParameters<typeof CodeGraphService>[0]['log'];
type CodeGraphEnvironment = NonNullable<ConstructorParameters<typeof CodeGraphService>[0]['command']['environment']>;
type LogEvent = { event: string; details: Record<string, unknown> };

test('development CodeGraph commands use the configured Bun and source entrypoints', () => {
  const commands = createCodeGraphCommands({ packaged: false, resourcesPath: '/resources', rootDirectory: '/source', bunExecutable: ' /custom/bun ' });
  const environment = { CHESHI_VIEWER_API_PORT: '43111' };
  expect(commands.cli()).toEqual({ executable: '/custom/bun', args: [join('/source', 'cli/cheshi-cli.ts')] });
  expect(commands.viewer(environment)).toEqual({ executable: '/custom/bun', args: [join('/source', 'desktop/backend/codegraph-host.ts')], environment });
});

test('packaged CodeGraph commands use bundled executables without development dependencies', () => {
  const commands = createCodeGraphCommands({ packaged: true, resourcesPath: '/resources', rootDirectory: '/source' });
  const runtime = join('/resources', 'runtime', `${process.platform}-${process.arch}`);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  expect(commands.cli()).toEqual({ executable: join(runtime, `cheshi-cli${suffix}`), args: [] });
  expect(commands.viewer({})).toEqual({ executable: join(runtime, `cheshi-codegraph-host${suffix}`), args: [], environment: {} });
});

function createFakeCodeGraphServer(directory: string): string {
  const script = join(directory, 'fake-codegraph-server.mjs');
  writeFileSync(script, `
const port = process.env.CHESHI_VIEWER_API_PORT || '43110';
process.stdout.write(JSON.stringify({ type: 'ready', url: 'http://127.0.0.1:' + port }) + '\\n');
setInterval(() => {}, 1_000);
`);
  return script;
}

function createService(
  directory: string,
  log: CodeGraphLogger,
  environment: CodeGraphEnvironment = {},
): CodeGraphService {
  return new CodeGraphService({
    command: {
      executable: process.execPath,
      args: [createFakeCodeGraphServer(directory)],
      environment,
    },
    log,
  });
}

function createFakeCodeGraphCli(directory: string): string {
  const script = join(directory, 'fake-codegraph-cli.mjs');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.CHESHI_TEST_CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  codeGraphDataRoot: process.env.CODEGRAPH_DATA_ROOT,
  noColor: process.env.NO_COLOR,
}));
`);
  return script;
}

describe('CodeGraphService', () => {
  test('does not log the child exit during an intentional stop', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cheshi-codegraph-service-'));
    const events: LogEvent[] = [];
    const service = createService(directory, (event, details) => {
      events.push({ event, details });
    });

    try {
      expect(await service.start(directory, directory, directory)).toBe('http://127.0.0.1:43110');
      await service.stop();
      expect(events).toEqual([]);
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('logs an unexpected child exit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cheshi-codegraph-service-'));
    const events: LogEvent[] = [];
    let resolveExitLog = () => {};
    const exitLogged = new Promise<void>((resolve) => {
      resolveExitLog = resolve;
    });
    const service = createService(directory, (event, details) => {
      events.push({ event, details });
      if (event === 'codegraph-exited') resolveExitLog();
    });

    try {
      await service.start(directory, directory, directory);
      const child = service.child;
      if (!child) throw new Error('Expected the fake CodeGraph child to be running.');
      child.kill('SIGTERM');
      await exitLogged;

      expect(events).toEqual([{
        event: 'codegraph-exited',
        details: { code: null, signal: 'SIGTERM' },
      }]);
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('passes command environment to the Viewer child', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cheshi-codegraph-service-'));
    const service = createService(directory, () => {}, { CHESHI_VIEWER_API_PORT: '43111' });

    try {
      expect(await service.start(directory, directory, directory)).toBe('http://127.0.0.1:43111');
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('CodeGraphIndexer', () => {
  for (const operation of ['reindex', 'initialize'] as const) {
    test(`runs ${operation} through the configured Cheshi CLI`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'cheshi-codegraph-indexer-'));
      const capturePath = join(directory, 'invocation.json');
      const dataRoot = join(directory, 'cheshi-data');
      const indexer = new CodeGraphIndexer({
        command: {
          executable: process.execPath,
          args: [createFakeCodeGraphCli(directory)],
          environment: { CHESHI_TEST_CAPTURE_PATH: capturePath },
        },
      });

      try {
        await indexer[operation](directory, dataRoot);
        const invocation = JSON.parse(readFileSync(capturePath, 'utf8'));
        if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
          throw new Error('Expected the fake CodeGraph CLI invocation to be an object.');
        }
        deepStrictEqual(invocation, {
          args: operation === 'initialize' ? ['codegraph', 'init', directory] : ['codegraph', 'index', '--quiet', directory],
          codeGraphDataRoot: dataRoot,
          noColor: '1',
        });
      } finally {
        await indexer.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test('reports initialization errors written to stdout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cheshi-codegraph-init-error-'));
    const indexer = new CodeGraphIndexer({ command: {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("Initialization failed: fixture error"); process.exitCode = 1;'],
    } });
    try {
      let failure: unknown;
      try { await indexer.initialize(directory, directory); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('fixture error');
    } finally {
      await indexer.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
