import type { Command } from "commander";
import { error } from './cli-output';

export function registerInstallCommands(program: Command, packageJson: { version: string }): void {


  /**
   * codegraph install
   */
  program
    .command('install')
    .description('Install codegraph MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
    .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
    .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
    .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
    .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
    .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
    .option('--refresh', 'Rewrite what previous installs configured, for already-configured agents only (never adds new ones)')
    .action(async (opts: {
      target?: string;
      location?: string;
      yes?: boolean;
      permissions?: boolean;
      printConfig?: string;
      refresh?: boolean;
    }) => {
      if (opts.printConfig) {
        const { getTarget, listTargetIds } = await import('../installer/targets/registry');
        const target = getTarget(opts.printConfig);
        if (!target) {
          const known = listTargetIds().join(', ');
          error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
          process.exit(1);
        }
        const loc = (opts.location === 'local' ? 'local' : 'global') as 'global' | 'local';
        process.stdout.write(target.printConfig(loc));
        return;
      }

      // --refresh: non-interactive sweep that re-writes what previous
      // installs configured (instructions section, MCP entry, legacy-hook
      // cleanups) for already-configured agents, so those surfaces match
      // THIS binary's templates. Skips everything else — never a first
      // install, never touches permissions or the prompt hook. Sweeps both
      // locations unless --location narrows it.
      if (opts.refresh) {
        const { refreshTargets } = await import('../installer');
        const { ALL_TARGETS } = await import('../installer/targets/registry');
        if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
          error(`--location must be "global" or "local" (got "${opts.location}").`);
          process.exit(1);
        }
        const locs: Array<'global' | 'local'> = opts.location
          ? [opts.location as 'global' | 'local']
          : ['global', 'local'];
        let changed = 0;
        for (const loc of locs) {
          for (const report of refreshTargets(ALL_TARGETS, loc)) {
            for (const p of report.changedPaths) {
              changed += 1;
              console.log(`  ${report.displayName}: refreshed ${p}`);
            }
          }
        }
        if (changed === 0) {
          console.log('All configured agent surfaces are already current.');
        }
        return;
      }

      const { runInstallerWithOptions } = await import('../installer');
      if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
        error(`--location must be "global" or "local" (got "${opts.location}").`);
        process.exit(1);
      }
      try {
        // Commander's `--no-permissions` makes `opts.permissions === false`;
        // omitting the flag leaves it `true` (the positive-form default).
        // We MUST treat the default-true as "user did not override — let
        // the orchestrator prompt" and only forward an explicit `false`
        // (or `true` when --yes implies it). Otherwise the auto-allow
        // prompt is silently skipped on every interactive run.
        const explicitNoPermissions = opts.permissions === false;
        const autoAllow: boolean | undefined = explicitNoPermissions
          ? false
          : opts.yes
            ? true
            : undefined;

        await runInstallerWithOptions({
          target: opts.target,
          location: opts.location as 'global' | 'local' | undefined,
          autoAllow,
          yes: opts.yes,
        });
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });


  /**
   * codegraph uninstall
   *
   * Inverse of `install`. Removes the codegraph MCP server entry,
   * instructions block, and permissions from every agent (or a
   * `--target` subset). Prompts global-vs-local when not given. Does NOT
   * delete the `.codegraph/` index — that's `codegraph uninit`.
   */
  program
    .command('uninstall')
    .description('Remove codegraph from your agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
    .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "all". Default: all')
    .option('-l, --location <where>', 'Uninstall location: "global" or "local". Default: prompt')
    .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=all')
    .action(async (opts: {
      target?: string;
      location?: string;
      yes?: boolean;
    }) => {
      const { runUninstaller } = await import('../installer');
      if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
        error(`--location must be "global" or "local" (got "${opts.location}").`);
        process.exit(1);
      }
      try {
        await runUninstaller({
          target: opts.target,
          location: opts.location as 'global' | 'local' | undefined,
          yes: opts.yes,
        });
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });


  /**
   * codegraph version
   *
   * The bare-noun form of `--version`. commander already provides `--version`
   * and `-V`, and the `-v` / `-version` spellings are intercepted before parse
   * (see top of main). This subcommand makes `codegraph version` work and lists
   * the version affordance in `codegraph --help`.
   */
  program
    .command('version')
    .description('Print the installed CodeGraph version (also: -v, --version)')
    .action(() => {
      console.log(packageJson.version);
    });
}
