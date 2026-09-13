#!/usr/bin/env bun
import '../mcp/early-ppid';
import { registerFileCommands } from './cli-file-commands';
import { registerIndexCommands } from './cli-index-commands';
import { registerInstallCommands } from './cli-install-commands';
import { registerRelationCommands } from './cli-relation-commands';
import { registerSearchCommands } from './cli-search-commands';
import { registerServerCommands } from './cli-server-commands';
import { buildBunRuntimeBanner, isUnsupportedBunVersion } from './bun-version-check';
import { installFatalHandlers } from './fatal-handler';
import { Command } from 'commander';
import { CodeGraphPackageVersion } from '../mcp/version';

const bunVersion = process.versions.bun;

if (isUnsupportedBunVersion(bunVersion)) {
  process.stderr.write(buildBunRuntimeBanner(bunVersion) + '\n');
  process.exit(1);
}

// Last-resort fatal handlers: log a bounded line and exit non-zero. A fault
// that reaches here escaped every boundary, so the process is in an undefined
// state — keeping it alive is what let the detached MCP daemon orphan and pin a
// CPU core with no recovery (#799, #850). Installed before the command branch
// so it also covers a synchronous throw during startup. See ./fatal-handler.
installFatalHandlers();

// Check if running with no arguments - run installer
if (process.argv.length === 2) {
  import('../installer').then(({ runInstaller }) =>
    runInstaller()
  ).catch((err) => {
    console.error('Installation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

function main() {

  const program = new Command();

  const packageJson = { version: CodeGraphPackageVersion };

  // Make the version trivial to reach. commander's `.version()` (below) wires up
  // `--version` and `-V`; intercept the spellings it can't — lowercase `-v` and
  // single-dash `-version` — before any parsing. (commander's version short flag
  // is the capital `-V`, and its parser rejects a multi-character single-dash
  // flag.) The bare `codegraph version` subcommand is registered further down so
  // the affordance also shows up in `codegraph --help`.
  const firstArg = process.argv[2];
  if (firstArg === '-v' || firstArg === '-version') {
    console.log(packageJson.version);
    return;
  }

  // =============================================================================
  // ANSI Color Helpers (avoid chalk ESM issues)
  // =============================================================================

  // `--color` / `--no-color` are global and position-independent — they were
  // already read by ansiColorsEnabled() at module load, so strip them before
  // commander parses (a subcommand would otherwise reject the unknown flag).
  process.argv = process.argv.filter((a) => a !== '--color' && a !== '--no-color');

  program
    .name(process.env.CODEGRAPH_CLI_NAME?.trim() || 'codegraph')
    .description('Code intelligence and knowledge graph for any codebase')
    .version(packageJson.version)
    // Parsed manually before commander runs (any argv position works); declared
    // here so they show up in --help. NO_COLOR / FORCE_COLOR env vars are also
    // honored, and piped output defaults to no color (#1281).
    .option('--color', 'force ANSI colors even when stdout is not a TTY')
    .option('--no-color', 'disable ANSI colors (NO_COLOR env is also honored)');



  registerIndexCommands(program, packageJson);

  registerSearchCommands(program);

  registerFileCommands(program);

  registerServerCommands(program);

  registerRelationCommands(program);

  registerInstallCommands(program, packageJson);

  // Parse and run
  program.parse();

}
