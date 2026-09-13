import type { Command } from "commander";
import { findNearestCodeGraphRoot, getCodeGraphDir, isInitialized } from '../directory';
import { getGlyphs } from '../ui/glyphs';
import { chalk, error, formatDuration, info, success } from './cli-output';
import { resolveProjectPath } from './cli-project';
import { loadClack } from './cli-runtime';
import * as fs from 'fs';
import * as path from 'path';

export function registerServerCommands(program: Command): void {


  /**
   * codegraph daemon — interactive manager for the background daemons. Arrow keys
   * to pick one (the current project's daemon floats to the top, auto-selected),
   * enter to stop it. Falls back to a plain list when output isn't a TTY.
   */
  program
    .command('daemon')
    .aliases(['daemons'])
    .description('Manage running CodeGraph background daemons — pick one and press enter to stop it')
    .action(async () => {
      const { listDaemons, stopDaemonAt, stopAllDaemons } = await import('../mcp/daemon-registry');
      const { runDaemonPicker } = await import('../mcp/daemon-manager');

      const daemons = listDaemons();
      if (daemons.length === 0) {
        info('No CodeGraph daemons running.');
        return;
      }

      // No TTY (piped / CI / non-interactive) — can't do arrow-key selection, so
      // just print what's running instead of crashing on a prompt with no input.
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        for (const d of daemons) {
          console.log(`pid ${d.pid}  v${d.version}  up ${formatDuration(Date.now() - d.startedAt)}  ${d.root}`);
        }
        return;
      }

      // The current project's daemon floats to the top and is pre-selected.
      let cwdRoot: string | null = null;
      const found = findNearestCodeGraphRoot(process.cwd());
      if (found) { try { cwdRoot = fs.realpathSync(found); } catch { cwdRoot = found; } }

      const clack = await loadClack();
      clack.intro('CodeGraph daemons');
      await runDaemonPicker({
        list: listDaemons,
        stop: stopDaemonAt,
        stopAll: stopAllDaemons,
        cwdRoot,
        now: () => Date.now(),
        select: (opts) => clack.select(opts),
        isCancel: (v) => clack.isCancel(v),
        note: (m) => clack.log.success(m),
        done: (m) => clack.outro(m),
      });
    });


  /**
   * codegraph serve
   */
  program
    // Hidden from `--help`: this is the stdio entry point an AI agent launches
    // for itself (the installer wires `args: ['serve','--mcp']` into every
    // agent's MCP config), not a command a human runs. It still works when
    // invoked — hiding only removes it from the listing. See the interactive-TTY
    // guard below, which explains this to anyone who runs it by hand.
    .command('serve', { hidden: true })
    .description('Start CodeGraph as an MCP server for AI assistants')
    .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
    .option('--mcp', 'Run as MCP server (stdio transport)')
    .option('--no-watch', 'Disable the file watcher (no auto-sync; useful on slow filesystems like WSL2 /mnt drives)')
    .action(async (options: { path?: string; mcp?: boolean; watch?: boolean }) => {
      const projectPath = options.path ? resolveProjectPath(options.path) : undefined;

      // Commander sets watch=false when --no-watch is passed. Route it through
      // the same env-var chokepoint the watcher and MCP server already honor.
      if (options.watch === false) {
        process.env.CODEGRAPH_NO_WATCH = '1';
      }

      try {
        if (options.mcp) {
          // `serve --mcp` is the stdio MCP server an AI agent launches for itself,
          // not a command to run by hand. A human in a terminal would otherwise
          // see it hang waiting for JSON-RPC on stdin, which reads as broken. If
          // stdin is an interactive TTY, explain instead of hanging. The agent's
          // pipe and the detached daemon both have a non-TTY stdin, so this only
          // ever fires for a person who typed it.
          if (process.stdin.isTTY && !process.env.CODEGRAPH_DAEMON_INTERNAL) {
            console.error(chalk.bold('\nCodeGraph MCP server\n'));
            console.error("This is the MCP server your AI agent (Claude Code, Cursor, Codex, opencode, …)");
            console.error("starts automatically — you don't run it yourself.");
            console.error(`\nIt's already wired up by ${chalk.cyan('codegraph install')}. To check on things:`);
            console.error(`  ${chalk.cyan('codegraph status')}   ${chalk.dim('— is this project indexed and healthy?')}`);
            console.error(`  ${chalk.cyan('codegraph daemon')}   ${chalk.dim('— list or stop background MCP servers')}`);
            console.error(chalk.dim('\n(Running it directly only does something when an MCP client drives it over stdin.)'));
            return;
          }
          // Start MCP server - it handles initialization lazily based on rootUri from client
          const { MCPServer } = await import('../mcp/index');
          const server = new MCPServer(projectPath);
          await server.start();
          // Server will run until terminated
        } else {
          // Default: show info about MCP mode.
          // Use stderr so stdout stays clean for any piped/stdio usage.
          console.error(chalk.bold('\nCodeGraph MCP Server\n'));
          console.error(chalk.blue(getGlyphs().info) + ' Use --mcp flag to start the MCP server');
          console.error('\nTo use with Claude Code, add to your MCP configuration:');
          console.error(chalk.dim(`
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
          console.error('Available tools:');
          console.error(chalk.cyan('  codegraph_explore') + '   - Primary: source of the relevant symbols for any question');
          console.error(chalk.cyan('  codegraph_search') + '    - Search for code symbols');
          console.error(chalk.cyan('  codegraph_callers') + '   - Find callers of a symbol');
          console.error(chalk.cyan('  codegraph_callees') + '   - Find what a symbol calls');
          console.error(chalk.cyan('  codegraph_impact') + '    - Analyze impact of changes');
          console.error(chalk.cyan('  codegraph_node') + '      - Get symbol details');
          console.error(chalk.cyan('  codegraph_files') + '     - Get project file structure');
          console.error(chalk.cyan('  codegraph_status') + '    - Get index status');
        }
      } catch (err) {
        error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph unlock [path]
   */
  program
    .command('unlock [path]')
    .description('Remove a stale lock file that is blocking indexing')
    .action(async (pathArg: string | undefined) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          return;
        }

        const lockPath = path.join(getCodeGraphDir(projectPath), 'codegraph.lock');

        if (!fs.existsSync(lockPath)) {
          info(`No lock file found ${getGlyphs().dash} nothing to do`);
          return;
        }

        fs.unlinkSync(lockPath);
        success('Removed lock file. You can now run indexing again.');
      } catch (err) {
        error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
