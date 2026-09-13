import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import path from 'node:path';

import { CodeGraph } from '../../codegraph/src';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';

const repositoryRoot = path.resolve(import.meta.dir, '../..');
const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-cli-runtime-'));
const compiledCliPath = path.join(runtimeDirectory, 'cheshi-cli');
const codeGraphRequire = createRequire(path.join(repositoryRoot, 'codegraph', 'package.json'));

interface SpawnedMcpServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function runCompiledCli(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(compiledCliPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...environment },
  });
}

function readFileIfPresent(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function spawnCompiledMcpServer(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
): SpawnedMcpServer {
  const child = spawn(
    compiledCliPath,
    ['codegraph', 'serve', '--mcp', '--path', workspaceRoot],
    {
      cwd: workspaceRoot,
      env: { ...process.env, NO_COLOR: '1', ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams;
  child.on('error', () => { /* surfaced through the response timeout */ });
  child.stdin.on('error', () => { /* the child may exit during cleanup */ });

  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const [stream, lines] of [[child.stdout, stdout], [child.stderr, stderr]] as const) {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
  }
  return { child, stdout, stderr };
}

function sendMcpMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendInitialize(child: ChildProcessWithoutNullStreams, workspaceRoot: string, id: number): void {
  sendMcpMessage(child, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'compiled-runtime-test', version: '0.0.0' },
      rootUri: `file://${workspaceRoot}`,
    },
  });
}

function findResponse(lines: readonly string[], id: number): Record<string, unknown> | null {
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (
        typeof value === 'object'
        && value !== null
        && 'id' in value
        && value.id === id
        && ('result' in value || 'error' in value)
      ) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Ignore non-JSON diagnostic output.
    }
  }
  return null;
}

async function waitFor<T>(
  operation: () => T | null | undefined | false,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = operation();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonPid(indexDirectory: string): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(indexDirectory, 'daemon.pid'), 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || !('pid' in value)) return null;
    return typeof value.pid === 'number' ? value.pid : null;
  } catch {
    return null;
  }
}

function daemonFailureDetails(server: SpawnedMcpServer, indexDirectory: string): string {
  return [
    'proxy stderr:',
    server.stderr.join('\n') || '<empty>',
    'daemon log:',
    readFileIfPresent(path.join(indexDirectory, 'daemon.log')) || '<missing>',
  ].join('\n');
}

async function initializeCentralIndex(dataRoot: string, workspaceRoot: string): Promise<void> {
  const previousDataRoot = process.env.CODEGRAPH_DATA_ROOT;
  process.env.CODEGRAPH_DATA_ROOT = dataRoot;
  try {
    const codeGraph = await CodeGraph.init(workspaceRoot);
    codeGraph.close();
  } finally {
    if (previousDataRoot === undefined) delete process.env.CODEGRAPH_DATA_ROOT;
    else process.env.CODEGRAPH_DATA_ROOT = previousDataRoot;
  }
}

async function stopProcess(pid: number | undefined): Promise<void> {
  if (!pid || !processIsAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await waitFor(() => !processIsAlive(pid), 5_000, `process ${pid} to exit`).catch(() => undefined);
  if (processIsAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
}

beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    [
      'build',
      '--compile',
      path.join(repositoryRoot, 'cli', 'cheshi-cli.ts'),
      '--outfile',
      compiledCliPath,
    ],
    { cwd: runtimeDirectory, encoding: 'utf8' },
  );
  expect(build.status, build.stderr).toBe(0);
  fs.copyFileSync(
    path.join(repositoryRoot, '.env.product'),
    path.join(runtimeDirectory, '.env.product'),
  );
  fs.copyFileSync(
    path.join(repositoryRoot, 'codegraph', 'src', 'db', 'schema.sql'),
    path.join(runtimeDirectory, 'schema.sql'),
  );
  const webTreeSitterEntry = codeGraphRequire.resolve('web-tree-sitter');
  fs.copyFileSync(
    path.join(path.dirname(webTreeSitterEntry), 'tree-sitter.wasm'),
    path.join(runtimeDirectory, 'tree-sitter.wasm'),
  );
});

afterAll(() => {
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});

describe('compiled cheshi-cli runtime', () => {
  it('loads every installer target when printing MCP configuration', () => {
    const dataRoot = fs.mkdtempSync(path.join(runtimeDirectory, 'data-'));
    const result = runCompiledCli(
      ['codegraph', 'install', '--print-config', 'codex', '--location', 'global'],
      { CODEGRAPH_DATA_ROOT: dataRoot },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('command = "cheshi-cli"');
    expect(result.stdout).toContain('args = ["codegraph", "serve", "--mcp"]');
  });

  it('installs and uninstalls agent configuration in an isolated home directory', () => {
    const isolatedHome = fs.mkdtempSync(path.join(runtimeDirectory, 'home-'));
    const dataRoot = path.join(isolatedHome, 'cheshi-data');
    const configHome = path.join(isolatedHome, '.config');
    const environment = {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      CODEGRAPH_DATA_ROOT: dataRoot,
      XDG_CONFIG_HOME: configHome,
    };

    const install = runCompiledCli(
      ['codegraph', 'install', '--target', 'codex,opencode', '--location', 'global', '--yes'],
      environment,
    );
    expect(install.status, install.stderr).toBe(0);

    const configPath = path.join(isolatedHome, '.codex', 'config.toml');
    const instructionsPath = path.join(isolatedHome, '.codex', 'AGENTS.md');
    const openCodeConfigPath = path.join(configHome, 'opencode', 'opencode.jsonc');
    expect(fs.readFileSync(configPath, 'utf8')).toContain('[mcp_servers.codegraph]');
    expect(fs.readFileSync(instructionsPath, 'utf8')).toContain('<!-- CODEGRAPH_START -->');
    expect(fs.readFileSync(openCodeConfigPath, 'utf8')).toContain('"codegraph"');

    const uninstall = runCompiledCli(
      ['codegraph', 'uninstall', '--target', 'codex,opencode', '--location', 'global', '--yes'],
      environment,
    );
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(readFileIfPresent(configPath)).not.toContain('[mcp_servers.codegraph]');
    expect(readFileIfPresent(instructionsPath)).not.toContain('<!-- CODEGRAPH_START -->');
    expect(readFileIfPresent(openCodeConfigPath)).not.toContain('"codegraph"');
  });

  it('shares one daemon between public CLI MCP clients', async () => {
    const dataRoot = fs.mkdtempSync(path.join(runtimeDirectory, 'daemon-data-'));
    const workspaceRoot = fs.mkdtempSync(path.join(runtimeDirectory, 'daemon-workspace-'));
    await initializeCentralIndex(dataRoot, workspaceRoot);
    const indexDirectory = codeGraphStorageDirectory(dataRoot, workspaceRoot);
    const environment = {
      CODEGRAPH_DATA_ROOT: dataRoot,
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '15000',
      CODEGRAPH_MCP_LOG_ATTACH: '1',
    };
    const servers: SpawnedMcpServer[] = [];
    let daemonPid: number | null = null;

    try {
      const first = spawnCompiledMcpServer(workspaceRoot, environment);
      servers.push(first);
      sendInitialize(first.child, workspaceRoot, 1);
      await waitFor(() => findResponse(first.stdout, 1), 10_000, 'first MCP initialize response');
      try {
        await waitFor(
          () => first.stderr.some((line) => line.includes('Attached to shared daemon')),
          10_000,
          'first client to attach to the shared daemon',
        );
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${daemonFailureDetails(first, indexDirectory)}`);
      }
      daemonPid = await waitFor(
        () => readDaemonPid(indexDirectory),
        10_000,
        'shared daemon pidfile',
      );

      const second = spawnCompiledMcpServer(workspaceRoot, environment);
      servers.push(second);
      sendInitialize(second.child, workspaceRoot, 2);
      await waitFor(() => findResponse(second.stdout, 2), 10_000, 'second MCP initialize response');
      await waitFor(
        () => second.stderr.some((line) => line.includes('Attached to shared daemon')),
        10_000,
        'second client to attach to the shared daemon',
      );

      expect(readDaemonPid(indexDirectory)).toBe(daemonPid);
      expect(processIsAlive(daemonPid)).toBe(true);
      const daemonLog = fs.readFileSync(path.join(indexDirectory, 'daemon.log'), 'utf8');
      expect(daemonLog).not.toContain('Unknown command: serve');
      expect(daemonLog.split('\n').filter((line) => line.includes('[CodeGraph daemon] Listening on'))).toHaveLength(1);
    } finally {
      for (const server of servers) {
        server.child.stdin.end();
        await stopProcess(server.child.pid);
      }
      await stopProcess(daemonPid ?? undefined);
    }
  }, 40_000);
});
