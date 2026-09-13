import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodeGraphCommands } from '../lib/codegraph-service.mts';
import { CodexAccountClients } from '../lib/codex-account-clients.mts';
import { createWorkspaceCodeGraphMcp, workspaceCodeGraphMcpArgs } from '../lib/workspace-codegraph-mcp.mts';

const workspaceRoot = '/workspaces/white queen';
const dataRoot = '/support/Cheshi-FirstRun-01';
const packaged = createCodeGraphCommands({ packaged: true, resourcesPath: '/Applications/Cheshi.app/Contents/Resources', rootDirectory: '/unused' });
const options = { cli: packaged.cli(), workspaceRoot, dataRoot };

function config(args: string[]) {
  return Bun.TOML.parse(args.filter((_, index) => index % 2 === 1).join('\n')) as {
    mcp_servers: Record<string, { command?: string; args?: string[]; cwd?: string; enabled?: boolean; env?: Record<string, string> }>;
  };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test('fresh installations use the bundled CLI and the same workspace data root', () => {
  const { mcp_servers: servers } = config(workspaceCodeGraphMcpArgs(options, false));
  expect(servers.codegraph).toBeUndefined();
  expect(servers.cheshi_codegraph).toMatchObject({
    command: packaged.cli().executable, args: ['codegraph', 'serve', '--mcp', '--path', workspaceRoot],
    cwd: workspaceRoot, enabled: true,
    env: { CODEGRAPH_DATA_ROOT: dataRoot, CHESHI_USER_DATA_DIR: dataRoot, CODEGRAPH_MCP_READ_ONLY: '1' },
  });
});

test('development uses its own source entrypoint and TOML preserves unusual paths', () => {
  const root = '/source/Cheshi "test"\\개발';
  const commands = createCodeGraphCommands({ packaged: false, resourcesPath: '/unused', rootDirectory: root, bunExecutable: '/tools/bun' });
  const server = config(workspaceCodeGraphMcpArgs({ cli: commands.cli(), workspaceRoot: root, dataRoot: `${root}/data\nline` }, true)).mcp_servers;
  expect(server.cheshi_codegraph?.command).toBe('/tools/bun');
  expect(server.cheshi_codegraph?.args?.[0]).toBe(join(root, 'cli/cheshi-cli.ts'));
  expect(server.cheshi_codegraph?.cwd).toBe(root);
  expect(server.cheshi_codegraph?.env?.CODEGRAPH_DATA_ROOT).toBe(`${root}/data\nline`);
  expect(server.codegraph).toEqual({ enabled: false });
  expect(() => workspaceCodeGraphMcpArgs({ ...options, dataRoot: 'relative' }, false)).toThrow('absolute');
});

test('configuration inspection is shared per account and retried after failure', async () => {
  const inspected: Array<string | undefined> = [];
  let fail = true;
  const prepare = createWorkspaceCodeGraphMcp(options, async command => {
    inspected.push(command.environment?.CODEX_HOME);
    if (fail) throw new Error('inspection failed');
    return command.environment?.CODEX_HOME === '/default';
  });
  const command = { executable: 'codex', args: [], environment: { CODEX_HOME: '/default' } };
  await expectFailure(prepare(command), 'inspection failed');
  fail = false;
  const [first, second] = await Promise.all([prepare(command), prepare(command)]);
  expect(inspected).toEqual(['/default', '/default']);
  expect(first).toEqual(second);
  first.length = 0;
  expect((await prepare(command)).length).toBeGreaterThan(0);
  expect(config(await prepare({ ...command, environment: { CODEX_HOME: '/new-account' } })).mcp_servers.codegraph).toBeUndefined();
  expect(inspected).toEqual(['/default', '/default', '/new-account']);
});

function transport(pool: CodexAccountClients) {
  return pool.create({
    command: { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/codex-shutdown-server.mts', import.meta.url)), 'graceful'], environment: {} },
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    clientInfo: { name: 'mcp-test', title: 'MCP test', version: '1' },
    shutdownTimeouts: { gracefulMs: 100, forceMs: 1000 },
  });
}

test('retained and new chat transports keep app MCP arguments after switching accounts', async () => {
  const inspected: Array<string | undefined> = [];
  const prepare = createWorkspaceCodeGraphMcp(options, async command => {
    inspected.push(command.environment?.CODEX_HOME);
    return command.environment?.CODEX_HOME === '/default';
  });
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' }, prepare);
  const client = transport(pool);
  try {
    await client.start();
    expect(client.command.args).toContain('mcp_servers.codegraph.enabled=false');
    await pool.change({ CODEX_HOME: '/second' }, [client], async () => {});
    await client.start();
    expect(client.command.args).not.toContain('mcp_servers.codegraph.enabled=false');
    expect(client.command.args).toContain('cli_auth_credentials_store="file"');
    expect(client.command.args).toContain(`mcp_servers.cheshi_codegraph.env.CODEGRAPH_DATA_ROOT="${dataRoot}"`);
    const additional = transport(pool);
    await additional.start();
    expect(additional.command.args).toEqual(client.command.args);
    await pool.change({ CODEX_HOME: '/default' }, [client], async () => {});
    await client.start();
    expect(client.command.args).toContain('mcp_servers.codegraph.enabled=false');
    expect(client.command.args).not.toContain('cli_auth_credentials_store="file"');
    expect(inspected).toEqual(['/default', '/second']);
  } finally { await pool.stop(); }
});

test('closing during MCP preparation cannot start a late child process', async () => {
  let resolve!: (value: string[]) => void;
  const gate = new Promise<string[]>(accept => { resolve = accept; });
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' }, () => gate);
  const client = transport(pool);
  const started = client.start();
  await pool.stop();
  resolve([]);
  await expectFailure(started, 'stopped');
  expect(client.child).toBeNull();
});
