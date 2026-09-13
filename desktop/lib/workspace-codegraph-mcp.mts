import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const WORKSPACE_CODEGRAPH_MCP_NAME = 'cheshi_codegraph';

interface Command {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
}

interface Options {
  cli: Pick<Command, 'executable' | 'args'>;
  workspaceRoot: string;
  dataRoot: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f');
}

export function workspaceCodeGraphMcpArgs(options: Options, legacyServer: boolean): string[] {
  if (!path.isAbsolute(options.workspaceRoot) || !path.isAbsolute(options.dataRoot)) {
    throw new Error('CodeGraph workspace and data paths must be absolute.');
  }
  const args = [...options.cli.args, 'codegraph', 'serve', '--mcp', '--path', options.workspaceRoot];
  const settings = {
    command: tomlString(options.cli.executable),
    args: `[${args.map(tomlString).join(', ')}]`,
    cwd: tomlString(options.workspaceRoot),
    enabled: 'true',
    startup_timeout_sec: '30',
    'env.CODEGRAPH_DATA_ROOT': tomlString(options.dataRoot),
    'env.CHESHI_USER_DATA_DIR': tomlString(options.dataRoot),
    'env.CODEGRAPH_MCP_READ_ONLY': '"1"',
  };
  const overrides = Object.entries(settings).flatMap(([key, value]) => ['-c', `mcp_servers.${WORKSPACE_CODEGRAPH_MCP_NAME}.${key}=${value}`]);
  // A disabled entry without a transport is invalid in a fresh Codex home.
  if (legacyServer) overrides.push('-c', 'mcp_servers.codegraph.enabled=false');
  return overrides;
}

/** Inspect effective configuration without starting MCP servers or editing account files. */
async function hasLegacyCodeGraph(command: Command, cwd: string): Promise<boolean> {
  let output: string;
  try {
    const result = await execute(command.executable, ['mcp', 'list', '--json'], {
      cwd, env: { ...process.env, ...command.environment, NO_COLOR: '1' }, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    output = result.stdout;
  } catch {
    // CLI stderr/stdout may include private MCP environment values.
    throw new Error('Could not read Codex MCP configuration to prepare the workspace CodeGraph connection.');
  }
  let servers: unknown;
  try { servers = JSON.parse(output); } catch { throw new Error('Codex returned invalid MCP configuration.'); }
  if (!Array.isArray(servers)) throw new Error('Codex returned an invalid MCP server list.');
  return servers.some(server => server !== null && typeof server === 'object' && server.name === 'codegraph');
}

export function createWorkspaceCodeGraphMcp(options: Options, inspect = hasLegacyCodeGraph) {
  const prepared = new Map<string, Promise<string[]>>();
  return (command: Command): Promise<string[]> => {
    const key = JSON.stringify([command.executable, command.environment?.CODEX_HOME]);
    let pending = prepared.get(key);
    if (!pending) {
      pending = inspect(command, options.workspaceRoot).then(legacy => workspaceCodeGraphMcpArgs(options, legacy));
      prepared.set(key, pending);
      void pending.catch(() => { if (prepared.get(key) === pending) prepared.delete(key); });
    }
    return pending.then(args => [...args]);
  };
}
