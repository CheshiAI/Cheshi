export const CODEGRAPH_CLI_LAUNCHER_ENV = 'CODEGRAPH_CLI_LAUNCHER';

export interface CodeGraphCliInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve the public command used to start a CodeGraph operation.
 *
 * The standalone engine keeps its historical `codegraph` command. Cheshi's
 * `cheshi-cli` wrapper sets CODEGRAPH_CLI_LAUNCHER, which gives generated MCP
 * configurations the same stable entrypoint users invoke in a terminal.
 */
export function codeGraphCliInvocation(args: readonly string[] = []): CodeGraphCliInvocation {
  const launcher = process.env[CODEGRAPH_CLI_LAUNCHER_ENV]?.trim();
  if (launcher) {
    return {
      command: launcher,
      args: ['codegraph', ...args],
    };
  }
  return {
    command: 'codegraph',
    args: [...args],
  };
}

/**
 * Format the public CodeGraph command for user-facing help and instructions.
 * Keep this derived from the executable invocation so generated configuration
 * and documentation cannot drift onto different entrypoints.
 */
export function codeGraphCliCommand(args: readonly string[] = []): string {
  const invocation = codeGraphCliInvocation(args);
  return [invocation.command, ...invocation.args].join(' ');
}
