import type { PendingFile } from '../sync';

/**
 * Prefix each line of a source slice with its 1-based line number, matching
 * the Read tool's `cat -n` convention (number + tab) so the agent treats it
 * the same way it treats Read output.
 *
 * @param slice  contiguous source text (already extracted from the file)
 * @param firstLineNumber  the 1-based line number of the slice's first line
 */
export function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * Unique line-prefix for a per-file source section in codegraph_explore output.
 * Issue #778: tool results dropped ATX headings (`####`, `##`, `###`) for bold
 * labels so Markdown-rendering MCP clients (e.g. the Claude Code VSCode
 * extension) stop blowing every header up to H1–H4. The path is bold + a code
 * span so it still reads as a header, and the leading ``**` `` stays a UNIQUE,
 * greppable marker — no other explore line begins with it — that the explore
 * truncation boundary (`handleExplore`) keys off to cut on whole file sections.
 */
const FILE_SECTION_PREFIX = '**`';

// Placeholder for codegraph_explore's "Found N symbols across M files." line.
// The honest N/M can only be known after the final truncation drops trailing
// sections (#1046), so the header is emitted as this sentinel and substituted
// at the very end. This bracketed token never occurs in rendered source or a
// file path, so the final string-replace can't collide.
export const SUMMARY_SENTINEL = '[[codegraph-explore-summary]]';

export function fileSectionHeader(filePath: string, suffix: string): string {
  return suffix
    ? `${FILE_SECTION_PREFIX}${filePath}\`** — ${suffix}`
    : `${FILE_SECTION_PREFIX}${filePath}\`**`;
}

/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export function formatStaleBanner(stale: PendingFile[]): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their codegraph entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export function formatStaleFooter(stale: PendingFile[]): string {
  const MAX = 5;
  const now = Date.now();
  const shown = stale.slice(0, MAX);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = stale.length > MAX ? `\n  - …and ${stale.length - MAX} more` : '';
  return (
    `(Note: ${stale.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * Whole-index degradation banner (issue #876). Emitted at the top of a read
 * tool response when live watching has permanently stopped — at which point
 * `getPendingFiles()` is empty, so the per-file banner above can't fire even
 * though the index is now FROZEN and silently drifting stale. Leads with the
 * agent-actionable instruction (Read directly) and carries the reason, which
 * already names the operator remedy (`codegraph sync` / git hooks).
 */
export function formatDegradedBanner(reason: string | null): string {
  return (
    '⚠️ CodeGraph auto-sync is DISABLED — live file watching stopped, so the index is ' +
    'frozen and any file edited since then is stale here. Read files directly to confirm ' +
    'current content before relying on it.' +
    (reason ? `\n  Reason: ${reason}` : '')
  );
}
