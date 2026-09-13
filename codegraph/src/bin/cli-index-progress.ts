export type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
};
import { getCodeGraphDir } from '../directory';
import { getGlyphs } from '../ui/glyphs';
import { createShimmerProgress } from '../ui/shimmer-progress';
import { colors, formatDuration, formatNumber } from './cli-output';
import * as fs from 'fs';
import * as path from 'path';

// Shimmer progress renderer (runs in a worker thread for smooth animation)
// Imported at top of file from '../ui/shimmer-progress'

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines to stdout.
 */
function createVerboseProgress(): (progress: { phase: string; current: number; total: number; currentFile?: string }) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      console.log(`[${elapsed}s] Phase: ${progress.phase}`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * 100);
      // Log every 5% to keep output manageable
      if (pct >= lastPct + 5 || progress.current === progress.total) {
        lastPct = pct;
        console.log(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` ${getGlyphs().dash} ${progress.currentFile}` : ''}`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % 1000 === 0 || progress.current === 1) {
        console.log(`[${elapsed}s]   ${formatNumber(progress.current)} files found`);
      }
    }
  };
}

export async function runIndexWithProgress(
  verbose: boolean | undefined,
  indexAll: (options?: import('../index').IndexOptions) => Promise<IndexResult>,
): Promise<IndexResult> {
  if (verbose) {
    return indexAll({ onProgress: createVerboseProgress(), verbose: true });
  }
  process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
  const progress = createShimmerProgress();
  const result = await indexAll({ onProgress: progress.onProgress });
  await progress.stop();
  return result;
}

/**
 * Print indexing results using clack log methods
 */
export function printIndexResult(clack: typeof import('@clack/prompts'), result: IndexResult, projectPath?: string): void {
  const hasErrors = result.filesErrored > 0;

  // Surface non-file-level failures (e.g. lock-acquisition failure
  // when another indexer is running) before the file-count branches.
  // Without this the CLI falls through to "No files found to index",
  // which is actively misleading — the index DID run, it just couldn't
  // get the lock.
  //
  // If success is false but no severity:'error' entry exists in
  // `result.errors` (degenerate case — shouldn't happen in practice
  // but worth guarding because the result shape is plumbed through
  // multiple call sites), fall back to a generic message rather than
  // continuing to the misleading "No files found" branch or throwing.
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    clack.log.error(generic?.message ?? `Indexing failed ${getGlyphs().dash} no further details available`);
    return;
  }

  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
    // A PARTIAL index (files silently dropped mid-pipeline) must not pass
    // as a clean run — it's the difference between "indexed the repo" and
    // "indexed most of the repo, quietly". Only the completeness
    // reconciliation warning; per-file extractor warnings stay in the
    // error-code summary below.
    for (const w of result.errors.filter((e) => e.code === 'index_partial')) {
      clack.log.warn(w.message);
    }
  } else if (hasErrors) {
    clack.log.error(`Indexing failed ${getGlyphs().dash} all ${formatNumber(result.filesErrored)} files had errors`);
  } else {
    clack.log.warn('No files found to index');
  }

  if (hasErrors) {
    const errorsByCode = new Map<string, number>();
    for (const err of result.errors) {
      if (err.severity === 'error') {
        const code = err.code || 'unknown';
        errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
      }
    }

    const codeLabels: Record<string, string> = {
      parse_error: 'files failed to parse',
      read_error: 'files could not be read',
      size_exceeded: 'files exceeded size limit',
      path_traversal: 'blocked paths',
      unsupported_language: 'unsupported language',
      parser_error: 'parser initialization failures',
    };

    const breakdown = Array.from(errorsByCode)
      .map(([code, count]) => `${formatNumber(count)} ${codeLabels[code] || code}`)
      .join('\n');
    clack.note(breakdown, 'Error breakdown');

    if (projectPath) {
      writeErrorLog(projectPath, result.errors);
      clack.log.info('See .codegraph/errors.log for details');
    }

    if (result.filesIndexed > 0) {
      clack.log.info(`The index is fully usable ${getGlyphs().dash} only the failed files are missing.`);
    }
  } else if (projectPath) {
    const logPath = path.join(getCodeGraphDir(projectPath), 'errors.log');
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  }
}

/**
 * When an `init`/`index` produced an EMPTY graph and the reason is that the
 * project's own `.gitignore` excludes nested git repositories — the "super-repo
 * gitignores its child repos" layout (#1156), where `init` at the parent
 * correctly indexes ~nothing while `init` inside each child works — name those
 * repos and offer to index them. An interactive terminal gets a yes/no prompt
 * that writes `includeIgnored` to codegraph.json and re-indexes; a
 * non-interactive run just prints the one-line opt-in snippet. The caller gates
 * this on `nodesCreated === 0`, so a project that DID index real content is
 * never nagged about the gitignored reference clones it deliberately keeps out
 * (#970, #1065). Best-effort throughout: detection never breaks the command.
 */
export async function offerIndexIgnoredRepos(
  clack: typeof import('@clack/prompts'),
  projectPath: string,
  reindex: () => Promise<IndexResult>,
  opts: { interactive: boolean },
): Promise<IndexResult | undefined> {
  let repos: string[];
  try {
    const { findUnindexedIgnoredRepos } = await import('../extraction');
    repos = findUnindexedIgnoredRepos(projectPath);
  } catch {
    return; // detection is advisory — never let it break the command
  }
  if (repos.length === 0) return;

  const { PROJECT_CONFIG_FILENAME } = await import('../project-config');
  const isOne = repos.length === 1;
  const SHOWN = 6;
  const names = repos.slice(0, SHOWN).map((r) => r.replace(/\/$/, ''));
  const extra = repos.length > SHOWN ? ` (+${formatNumber(repos.length - SHOWN)} more)` : '';
  const snippet = `{ "includeIgnored": [${repos.map((p) => JSON.stringify(p)).join(', ')}] }`;

  clack.log.warn(
    `Your .gitignore excludes ${isOne ? 'a nested git repository' : `${formatNumber(repos.length)} nested git repositories`} here, ` +
    `so ${isOne ? 'it was' : 'they were'} not indexed: ${names.join(', ')}${extra}.`,
  );

  const manualHint = () => {
    clack.log.info(
      `If ${isOne ? "it's" : "they're"} your code, add ${isOne ? 'it' : 'them'} to ${PROJECT_CONFIG_FILENAME} and re-index:`,
    );
    clack.log.info(`  ${snippet}`);
  };

  if (!opts.interactive || !process.stdin.isTTY) {
    manualHint();
    return;
  }

  const yes = await clack.confirm({
    message: `Index ${isOne ? 'it' : `these ${formatNumber(repos.length)}`} now? Adds ${isOne ? 'it' : 'them'} to ${PROJECT_CONFIG_FILENAME}.`,
    initialValue: true,
  });
  if (clack.isCancel(yes) || !yes) {
    manualHint();
    return;
  }

  let added: number;
  try {
    const { addIncludeIgnoredPatterns } = await import('../project-config');
    added = addIncludeIgnoredPatterns(projectPath, repos);
  } catch (err) {
    clack.log.error(`Could not update ${PROJECT_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    manualHint();
    return;
  }
  clack.log.success(`Added ${formatNumber(added)} ${added === 1 ? 'entry' : 'entries'} to ${PROJECT_CONFIG_FILENAME} ${getGlyphs().dash} re-indexing…`);

  const result = await reindex();
  printIndexResult(clack, result, projectPath);
  return result;
}

/**
 * Write detailed error log to .codegraph/errors.log
 */
function writeErrorLog(projectPath: string, errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>): void {
  const cgDir = getCodeGraphDir(projectPath);
  if (!fs.existsSync(cgDir)) return;

  const logPath = path.join(cgDir, 'errors.log');

  // Group errors by file path
  const errorsByFile = new Map<string, Array<{ message: string; code?: string }>>();
  const noFileErrors: Array<{ message: string; code?: string }> = [];

  for (const err of errors) {
    if (err.severity !== 'error') continue;
    if (err.filePath) {
      let list = errorsByFile.get(err.filePath);
      if (!list) {
        list = [];
        errorsByFile.set(err.filePath, list);
      }
      list.push({ message: err.message, code: err.code });
    } else {
      noFileErrors.push({ message: err.message, code: err.code });
    }
  }

  const lines: string[] = [
    `CodeGraph Error Log - ${new Date().toISOString()}`,
    `${errorsByFile.size} files with errors`,
    '',
  ];

  for (const [filePath, fileErrors] of errorsByFile) {
    for (const err of fileErrors) {
      lines.push(`${filePath}: ${err.message}`);
    }
  }

  for (const err of noFileErrors) {
    lines.push(err.message);
  }

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
}
