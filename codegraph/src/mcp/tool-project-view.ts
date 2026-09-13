import { resolve as resolvePath } from 'path';
import {
  worktreeMismatchWarning
} from '../sync/worktree';
import {
  clamp
} from '../utils';
import {
  type ToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';

/**
   * Handle codegraph_status
   */
export async function handleStatus(this: ToolHandlerState, args: Record<string, unknown>): Promise<ToolResult> {
  let cg = this.getCodeGraph(args.projectPath as string | undefined);
  // Same trick as withStalenessNotice — when an explicit projectPath
  // resolves to the same project as the default session cg, prefer the
  // default so getPendingFiles() (only populated by the default's watcher)
  // is non-empty when there are pending edits.
  if (this.cg && cg !== this.cg) {
    try {
      if (resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot())) {
        cg = this.cg;
      }
    } catch { /* closed instance — leave as is */ }
  }
  const stats = cg.getStats();

  // Warn when this index actually belongs to a different git working tree
  // (e.g. the server resolved up from a nested worktree to the main checkout).
  // Queries then reflect that tree's branch, not the worktree being edited.
  // status shows the verbose, multi-line form; the read tools get the compact
  // one-liner via withWorktreeNotice. Both share the cached detection.
  const mismatch = this.worktreeMismatchFor(args.projectPath as string | undefined);

  const lines: string[] = [
    '**CodeGraph Status**',
    '',
  ];
  if (mismatch) {
    lines.push(`> ⚠ ${worktreeMismatchWarning(mismatch).replace(/\n/g, '\n> ')}`, '');
  }
  lines.push(
    `**Files indexed:** ${stats.fileCount}`,
    `**Total nodes:** ${stats.nodeCount}`,
    `**Total edges:** ${stats.edgeCount}`,
    `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
  );

  // Surface Bun's built-in SQLite backend (full WAL + FTS5, no native build).
  lines.push(`**Backend:** bun:sqlite (Bun built-in) — full WAL + FTS5`);

  // Effective journal mode. 'wal' ⇒ concurrent reads never block on a writer;
  // anything else ⇒ they can ("database is locked"). bun:sqlite supports WAL,
  // so a non-wal mode means the filesystem can't (network/
  // virtualized mounts, WSL2 /mnt). See issue #238.
  const journalMode = cg.getJournalMode();
  if (journalMode === 'wal') {
    lines.push(`**Journal mode:** wal (concurrent reads safe)`);
  } else {
    lines.push(
      `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
      `can block on a concurrent write (WAL appears unsupported on this filesystem)`
    );
  }

  // Non-zero at rest means a resolution pass was interrupted mid-run, so
  // some files' call/impact edges are missing until the next sync sweeps
  // the leftovers (#1187). Surface it — an agent trusting an incomplete
  // blast radius is worse than one that knows to re-sync.
  const pendingRefs = cg.getPendingReferenceCount();
  if (pendingRefs > 0) {
    lines.push(
      `**Pending resolution:** ⚠ ${pendingRefs} references from an interrupted ` +
      `index run — some caller/impact edges are missing until the next sync ` +
      `(any file change triggers it, or run \`codegraph sync\`)`
    );
  }

  lines.push('', '**Nodes by Kind:**');

  for (const [kind, count] of Object.entries(stats.nodesByKind)) {
    if ((count as number) > 0) {
      lines.push(`- ${kind}: ${count}`);
    }
  }

  lines.push('', '**Languages:**');
  for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
    if ((count as number) > 0) {
      lines.push(`- ${lang}: ${count}`);
    }
  }

  // Whole-index degradation (#876): when live watching has permanently
  // stopped, getPendingFiles() is empty (so no "Pending sync" section below)
  // but the index is frozen — call that out explicitly here, the one place an
  // agent asks "is the index caught up?".
  if (cg.isWatcherDegraded()) {
    lines.push(
      '',
      '**Auto-sync disabled:**',
      `- ${cg.getWatcherDegradedReason() ?? 'live file watching stopped'}`,
      '- The index is frozen; Read files directly for current content.'
    );
  }

  // Per-file freshness — the inverse of the auto-prepended staleness banner
  // (issue #403). Surfacing it inside `status` gives the agent a single
  // place to ask "is the index caught up?" rather than inferring from
  // banners on other tool calls.
  const pending = cg.getPendingFiles();
  if (pending.length > 0) {
    lines.push('', '**Pending sync:**');
    const now = Date.now();
    for (const p of pending) {
      const ageMs = Math.max(0, now - p.lastSeenMs);
      const label = p.indexing ? 'indexing in progress' : 'pending sync';
      lines.push(`- ${p.path} (edited ${ageMs}ms ago, ${label})`);
    }
  }

  return this.textResult(lines.join('\n'));
}

/**
   * Handle codegraph_files - get project file structure from the index
   */
export async function handleFiles(this: ToolHandlerState, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = this.getCodeGraph(args.projectPath as string | undefined);
  const pathFilter = args.path as string | undefined;
  const pattern = args.pattern as string | undefined;
  const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
  const includeMetadata = args.includeMetadata !== false;
  const maxDepth = args.maxDepth != null ? clamp(args.maxDepth as number, 1, 20) : undefined;

  // Get all files from the index
  const allFiles = cg.getFiles();

  if (allFiles.length === 0) {
    return this.textResult('No files indexed. Run `codegraph index` first.');
  }

  // Filter by path prefix. Stored paths are project-relative POSIX (e.g.
  // "src/foo.ts"), but agents commonly pass project-root variants like "/",
  // ".", "./", "" or Windows-style "src\foo" — and prefixes with leading
  // "/", "./" or "\". Normalize all of those before matching so the agent
  // gets results instead of falling back to Read/Glob (see #426).
  const normalizedFilter = pathFilter
    ? pathFilter
      .replace(/\\/g, '/')
      .replace(/^(?:\.?\/+)+/, '')
      .replace(/^\.$/, '')
      .replace(/\/+$/, '')
    : '';
  let files = normalizedFilter
    ? allFiles.filter(f => f.path === normalizedFilter || f.path.startsWith(normalizedFilter + '/'))
    : allFiles;

  // Filter by glob pattern
  if (pattern) {
    const regex = this.globToRegex(pattern);
    files = files.filter(f => regex.test(f.path));
  }

  if (files.length === 0) {
    return this.textResult(`No files found matching the criteria.`);
  }

  // Format output
  let output: string;
  switch (format) {
    case 'flat':
      output = this.formatFilesFlat(files, includeMetadata);
      break;
    case 'grouped':
      output = this.formatFilesGrouped(files, includeMetadata);
      break;
    case 'tree':
    default:
      output = this.formatFilesTree(files, includeMetadata, maxDepth);
      break;
  }

  return this.textResult(this.truncateOutput(output));
}

/**
   * Convert glob pattern to regex
   */
export function globToRegex(this: ToolHandlerState, pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars except * and ?
    .replace(/\*\*/g, '{{GLOBSTAR}}')       // Temp placeholder for **
    .replace(/\*/g, '[^/]*')                // * matches anything except /
    .replace(/\?/g, '[^/]')                 // ? matches single char except /
    .replace(/\{\{GLOBSTAR\x7D\x7D/g, '.*');    // ** matches anything including /
  return new RegExp(escaped);
}

/**
   * Format files as a flat list
   */
export function formatFilesFlat(this: ToolHandlerState, files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
  const lines: string[] = [`**Files (${files.length})**`, ''];

  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    if (includeMetadata) {
      lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
    } else {
      lines.push(`- ${file.path}`);
    }
  }

  return lines.join('\n');
}

/**
   * Format files grouped by language
   */
export function formatFilesGrouped(this: ToolHandlerState, files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
  const byLang = new Map<string, typeof files>();

  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }

  const lines: string[] = [`**Files by Language (${files.length} total)**`, ''];

  // Sort languages by file count (descending)
  const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [lang, langFiles] of sortedLangs) {
    lines.push(`**${lang} (${langFiles.length})**`);
    for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
   * Format files as a tree structure
   */
export function formatFilesTree(this: ToolHandlerState, files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean, maxDepth?: number): string {
  // Build tree structure
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      // If this is the last part, it's a file
      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  // Render tree
  const lines: string[] = [`**Project Structure (${files.length} files)**`, ''];

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
      }
      lines.push(line);
    }

    const children = [...node.children.values()];
    // Sort: directories first, then files, both alphabetically
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);

  return lines.join('\n');
}
