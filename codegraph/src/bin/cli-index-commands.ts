import type { Command } from "commander";
import { getCodeGraphDir, isInitialized, unsafeIndexRootReason } from '../directory';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { detectWorktreeIndexMismatch, worktreeMismatchWarning } from '../sync/worktree';
import { getGlyphs } from '../ui/glyphs';
import { createShimmerProgress } from '../ui/shimmer-progress';
import type { IndexResult } from './cli-index-progress';
import { offerIndexIgnoredRepos, printIndexResult, runIndexWithProgress } from './cli-index-progress';
import { chalk, colors, error, formatDuration, formatNumber, info, success, warn } from './cli-output';
import { resolveProjectPath } from './cli-project';
import { loadClack, loadCodeGraph } from './cli-runtime';
import { installCommandSupervision } from './command-supervision';
import * as path from 'path';

export function registerIndexCommands(program: Command, packageJson: { version: string }): void {


  // =============================================================================
  // Commands
  // =============================================================================

  /**
   * codegraph init [path]
   */
  program
    .command('init [path]')
    .description('Initialize CodeGraph in a project directory and build the initial index')
    .option('-i, --index', 'Deprecated: indexing now runs by default; flag accepted for backward compatibility')
    .option('-f, --force', 'Initialize even if the path looks like your home directory or a filesystem root')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .action(async (pathArg: string | undefined, options: { index?: boolean; force?: boolean; verbose?: boolean }) => {
      const projectPath = path.resolve(pathArg || process.cwd());
      const clack = await loadClack();

      clack.intro('Initializing CodeGraph');

      try {
        // Refuse to index your home directory / a filesystem root — it pulls in
        // caches, other projects, and your whole tree (a multi-GB index + watcher
        // churn, and on pre-1.0 macOS a machine-crashing fd blowup, #845).
        const unsafe = unsafeIndexRootReason(projectPath);
        if (unsafe && !options.force) {
          clack.log.error(`Refusing to initialize in ${projectPath} — it looks like ${unsafe}.`);
          clack.log.info('Run this inside a specific project directory, or pass --force if you really mean to index everything under it.');
          clack.outro('');
          process.exitCode = 1;
          return;
        }

        if (isInitialized(projectPath)) {
          clack.log.warn(`Already initialized in ${projectPath}`);
          clack.log.info('Use "codegraph index" to re-index or "codegraph sync" to update');
          try {
            const { offerWatchFallback } = await import('../installer');
            if (process.stdin.isTTY === true) await offerWatchFallback(clack, projectPath);
          } catch { /* non-fatal */ }
          clack.outro('');
          return;
        }

        const { default: CodeGraph, getDatabasePath } = await loadCodeGraph();
        const cg = await CodeGraph.init(projectPath, { index: false });
        clack.log.success(`Initialized in ${projectPath}`);

        // Indexing runs by default now. The legacy -i/--index flag is still
        // accepted (so existing muscle memory and scripts don't break) but is a
        // no-op — initializing always builds the initial index.
        // Supervise the index: self-terminate if orphaned or wedged (#999).
        // The DB + WAL paths let the liveness watchdog tell a slow store on
        // degraded storage from a true wedge (#1231).
        // A closure so we can re-run the exact same supervised, progress-rendered
        // index if the user opts gitignored child repos in below (#1156).
        const dbPath = getDatabasePath(projectPath);
        const runIndex = async (): Promise<IndexResult> => {
          const supervision = installCommandSupervision('init', { progressPaths: [dbPath, `${dbPath}-wal`] });
          try {
            return await runIndexWithProgress(options.verbose, (indexOptions) => cg.indexAll(indexOptions));
          } finally {
            supervision.stop();
          }
        };
        const result = await runIndex();
        printIndexResult(clack, result, projectPath);

        // An empty graph at a git super-repo usually means `.gitignore` excludes
        // the child repos that hold the code — surface them and offer to opt in
        // rather than leaving the user with a silent 0-node "Done". (#1156)
        let finalResult = result;
        if (result.nodesCreated === 0) {
          finalResult = (await offerIndexIgnoredRepos(clack, projectPath, runIndex, { interactive: true })) ?? result;
        }

        if (finalResult.success !== true) {
          cg.close();
          process.exitCode = 1;
          return;
        }

        try {
          const { offerWatchFallback } = await import('../installer');
          if (process.stdin.isTTY === true) await offerWatchFallback(clack, projectPath);
        } catch { /* non-fatal */ }

        clack.outro('Done');
        cg.close();
      } catch (err) {
        clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph uninit [path]
   */
  program
    .command('uninit [path]')
    .description('Remove CodeGraph from a project (deletes .codegraph/ directory)')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          warn(`CodeGraph is not initialized in ${projectPath}`);
          return;
        }

        if (!options.force) {
          // Confirm with user
          const readline = await import('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(
              chalk.yellow(`${getGlyphs().warn} This will permanently delete all CodeGraph data. Continue? (y/N) `),
              resolve
            );
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            info('Cancelled');
            return;
          }
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = CodeGraph.openSync(projectPath);
        cg.uninitialize();

        // Clean up any git sync hooks we installed (no-op if none / not a repo).
        try {
          const { removeGitSyncHook } = await import('../sync/git-hooks');
          const removed = removeGitSyncHook(projectPath);
          if (removed.installed.length > 0) {
            info(`Removed git ${removed.installed.join(', ')} sync hook${removed.installed.length > 1 ? 's' : ''}`);
          }
        } catch { /* non-fatal */ }

        success(`Removed CodeGraph from ${projectPath}`);
      } catch (err) {
        error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph index [path]
   */
  program
    .command('index [path]')
    .description('Rebuild the full index from scratch (same result as a fresh init)')
    .option('-f, --force', 'Index even if the path looks like your home directory or a filesystem root')
    .option('-q, --quiet', 'Suppress progress output')
    .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
    .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        // Don't (re)index your home directory / a filesystem root (#845). --force
        // doubles as the override.
        const unsafe = unsafeIndexRootReason(projectPath);
        if (unsafe && !options.force) {
          error(`Refusing to index ${projectPath} — it looks like ${unsafe}. Pass --force to override.`);
          process.exit(1);
        }

        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          info('Run "codegraph init" first');
          process.exit(1);
        }

        const { default: CodeGraph, getDatabasePath } = await loadCodeGraph();
        // `index` is a FULL re-index — identical to a fresh `init`. RECREATE the
        // database from scratch (discard .codegraph/codegraph.db + its WAL) rather
        // than opening the old graph and DELETE-ing every row. The clear-then-index
        // approach reported "0 nodes" without the clear (#874); the recreate keeps
        // that fixed AND avoids the failure mode where, on a large or pre-fix
        // poisoned index, the per-row FTS delete churn wedged the main thread long
        // enough to trip the liveness watchdog before scanning even began (#1067).
        // recreate() hands back a fresh, empty instance — no clear() needed. For
        // fast incremental updates use `sync`.
        const cg = await CodeGraph.recreate(projectPath);

        // Supervise the indexer: self-terminate if orphaned (parent shim killed)
        // or if the main thread wedges — neither was guarded on this path (#999).
        // The DB + WAL paths let the liveness watchdog tell a slow store on
        // degraded storage from a true wedge (#1231).
        const dbPath = getDatabasePath(projectPath);
        const supervision = installCommandSupervision('index', { progressPaths: [dbPath, `${dbPath}-wal`] });
        try {
          if (options.quiet) {
            // Quiet mode: no UI, just run against the freshly-recreated graph.
            const result = await cg.indexAll();
            if (!result.success) process.exit(1);
            cg.close();
            return;
          }

          const clack = await loadClack();
          clack.intro('Indexing project');

          // A closure so a re-index (after opting gitignored child repos in, #1156)
          // renders identically. Supervision already wraps the whole command.
          const renderIndex = async (): Promise<IndexResult> => {
            return runIndexWithProgress(options.verbose, (indexOptions) => cg.indexAll(indexOptions));
          };

          const result = await renderIndex();

          printIndexResult(clack, result, projectPath);

          // Empty graph at a git super-repo → likely `.gitignore`d child repos;
          // name them and offer to opt in instead of a silent 0-node result (#1156).
          let finalResult = result;
          if (result.nodesCreated === 0) {
            finalResult = (await offerIndexIgnoredRepos(clack, projectPath, renderIndex, { interactive: true })) ?? result;
          }

          if (!finalResult.success) {
            process.exit(1);
          }

          clack.outro('Done');
          cg.close();
        } finally {
          supervision.stop();
        }
      } catch (err) {
        error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph sync [path]
   */
  program
    .command('sync [path]')
    .description('Sync changes since last index')
    .option('-q, --quiet', 'Suppress output (for git hooks)')
    .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);

      try {
        if (!isInitialized(projectPath)) {
          if (!options.quiet) {
            error(`CodeGraph not initialized in ${projectPath}`);
          }
          process.exit(1);
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);

        if (options.quiet) {
          await cg.sync();
          cg.close();
          return;
        }

        const clack = await loadClack();
        clack.intro('Syncing CodeGraph');

        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();

        const result = await cg.sync({
          onProgress: progress.onProgress,
        });

        await progress.stop();

        const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

        if (totalChanges === 0) {
          clack.log.info('Already up to date');
        } else {
          clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
          const details: string[] = [];
          if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
          if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
          if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
          clack.log.info(`${details.join(', ')} ${getGlyphs().dash} ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
        }

        clack.outro('Done');
        cg.close();
      } catch (err) {
        if (!options.quiet) {
          error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(1);
      }
    });


  /**
   * codegraph status [path]
   */
  program
    .command('status [path]')
    .description('Show index status and statistics')
    .option('-j, --json', 'Output as JSON')
    .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      // The directory the user actually ran from, before walking up to the index
      // root. Used to detect when the resolved index lives in a different git
      // working tree (e.g. a nested worktree borrowing the main checkout's index).
      const startPath = path.resolve(pathArg || process.cwd());
      const worktreeMismatch = detectWorktreeIndexMismatch(startPath, projectPath);

      try {
        if (!isInitialized(projectPath)) {
          if (options.json) {
            console.log(JSON.stringify({
              initialized: false,
              version: packageJson.version,
              projectPath,
              indexPath: getCodeGraphDir(projectPath),
              lastIndexed: null,
            }));
            return;
          }
          console.log(chalk.bold('\nCodeGraph Status\n'));
          info(`Project: ${projectPath}`);
          warn('Not initialized');
          info('Run "codegraph init" to initialize');
          return;
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        const stats = cg.getStats();
        const changes = cg.getChangedFiles();
        const backend = cg.getBackend();
        const journalMode = cg.getJournalMode();

        const buildInfo = cg.getIndexBuildInfo();
        const reindexRecommended = cg.isIndexStale();
        const indexState = cg.getIndexState();
        // Zero on a healthy index; non-zero at rest means a resolution pass was
        // interrupted, so some files' call edges are missing (#1187).
        const pendingRefs = cg.getPendingReferenceCount();

        // JSON output mode
        if (options.json) {
          const lastIndexedMs = cg.getLastIndexedAt();
          console.log(JSON.stringify({
            initialized: true,
            version: packageJson.version,
            projectPath,
            indexPath: getCodeGraphDir(projectPath),
            lastIndexed: lastIndexedMs != null ? new Date(lastIndexedMs).toISOString() : null,
            fileCount: stats.fileCount,
            nodeCount: stats.nodeCount,
            edgeCount: stats.edgeCount,
            dbSizeBytes: stats.dbSizeBytes,
            walSizeBytes: stats.walSizeBytes,
            backend,
            journalMode,
            nodesByKind: stats.nodesByKind,
            languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
            pendingChanges: {
              added: changes.added.length,
              modified: changes.modified.length,
              removed: changes.removed.length,
            },
            worktreeMismatch: worktreeMismatch
              ? { worktreeRoot: worktreeMismatch.worktreeRoot, indexRoot: worktreeMismatch.indexRoot }
              : null,
            index: {
              builtWithVersion: buildInfo.version,
              builtWithExtractionVersion: buildInfo.extractionVersion,
              currentExtractionVersion: EXTRACTION_VERSION,
              reindexRecommended,
              // 'complete' | 'partial' (files silently dropped) | 'indexing'
              // (a run was killed mid-index — the index is truncated) |
              // 'failed' | null (predates the marker).
              state: indexState,
              // References awaiting resolution. Non-zero at rest means an
              // interrupted resolution pass left edges missing; the next
              // sync sweeps them (#1187).
              pendingRefs,
            },
          }));
          cg.close();
          return;
        }

        console.log(chalk.bold('\nCodeGraph Status\n'));

        // Project info
        console.log(chalk.cyan('Project:'), projectPath);
        if (worktreeMismatch) {
          warn(worktreeMismatchWarning(worktreeMismatch));
        }
        if (indexState === 'indexing') {
          warn('The last index run never finished (killed mid-index?) — the index is truncated. Re-run "codegraph index".');
        } else if (indexState === 'partial') {
          warn('The last index run silently dropped files — the index is partial. Re-run "codegraph index".');
        } else if (indexState === 'failed') {
          warn('The last index run failed — results may be incomplete. Re-run "codegraph index".');
        }
        if (pendingRefs > 0) {
          warn(`${formatNumber(pendingRefs)} references from an interrupted run are awaiting resolution — some callers/impact edges are missing. Run "codegraph sync" to resolve them.`);
        }
        console.log();

        // Index stats
        console.log(chalk.bold('Index Statistics:'));
        console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
        console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
        console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
        console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
        // Surface the WAL sidecar (#1431): a WAL that dwarfs the DB at rest is
        // the killed-session leak — invisible before this line, it only showed
        // up as a mysteriously full disk. open() above already kicked off the
        // automatic heal for the oversized case.
        if (stats.walSizeBytes > 0) {
          const { WAL_HEAL_THRESHOLD_BYTES } = await import('../db/index');
          const oversized = stats.walSizeBytes > Math.max(WAL_HEAL_THRESHOLD_BYTES, stats.dbSizeBytes);
          const walLabel = `${(stats.walSizeBytes / 1024 / 1024).toFixed(2)} MB`;
          console.log(`  WAL Size:  ${oversized ? chalk.yellow(walLabel) : walLabel}`);
          if (oversized) {
            warn('The write-ahead log is larger than the database — killed sessions left it behind. It is reclaimed automatically on open; if it persists across runs, another live CodeGraph process is holding it.');
          }
        }
        // Surface Bun's built-in SQLite backend (full WAL + FTS5, no native build).
        const backendLabel = chalk.green(`bun:sqlite ${getGlyphs().dash} built-in (full WAL)`);
        console.log(`  Backend:   ${backendLabel}`);
        // Effective journal mode: 'wal' means concurrent reads never block on a
        // writer; anything else means they can ("database is locked"). bun:sqlite
        // supports WAL, so a non-wal mode means the filesystem can't
        // (network mounts, WSL2 /mnt). See issue #238.
        const journalLabel = journalMode === 'wal'
          ? chalk.green('wal')
          : chalk.yellow(`${journalMode || 'unknown'} ${getGlyphs().dash} WAL inactive; reads can block on writes`);
        console.log(`  Journal:   ${journalLabel}`);
        console.log();

        // Node breakdown
        console.log(chalk.bold('Nodes by Kind:'));
        const nodesByKind = Object.entries(stats.nodesByKind)
          .filter(([, count]) => count > 0)
          .sort((a, b) => b[1] - a[1]);
        for (const [kind, count] of nodesByKind) {
          console.log(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
        }
        console.log();

        // Language breakdown
        console.log(chalk.bold('Files by Language:'));
        const filesByLang = Object.entries(stats.filesByLanguage)
          .filter(([, count]) => count > 0)
          .sort((a, b) => b[1] - a[1]);
        for (const [lang, count] of filesByLang) {
          console.log(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
        }
        console.log();

        // Pending changes
        const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
        if (totalChanges > 0) {
          console.log(chalk.bold('Pending Changes:'));
          if (changes.added.length > 0) {
            console.log(`  Added:     ${changes.added.length} files`);
          }
          if (changes.modified.length > 0) {
            console.log(`  Modified:  ${changes.modified.length} files`);
          }
          if (changes.removed.length > 0) {
            console.log(`  Removed:   ${changes.removed.length} files`);
          }
          info('Run "codegraph sync" to update the index');
        } else {
          success('Index is up to date');
        }
        console.log();

        // Re-index hint: the index was built by an older engine than the one now
        // running, so a rebuild would add data a migration can't backfill.
        if (reindexRecommended) {
          const builtWith = buildInfo.version ? `v${buildInfo.version.replace(/^v/, '')}` : 'an earlier version';
          warn(`Index was built by ${builtWith}; re-index to pick up this engine's improvements.`);
          info('Run "codegraph index" (full rebuild) or "codegraph sync"');
          console.log();
        }

        cg.close();
      } catch (err) {
        error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
