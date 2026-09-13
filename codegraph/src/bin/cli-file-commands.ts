import type { Command } from "commander";
import { isInitialized } from '../directory';
import { getGlyphs } from '../ui/glyphs';
import { chalk, error, info } from './cli-output';
import { resolveProjectPath } from './cli-project';
import { loadCodeGraph } from './cli-runtime';
import * as path from 'path';

/**
 * Normalize a user-supplied file path to the project-relative, forward-slash
 * form CodeGraph stores in the index. Accepts an absolute path, a `./`-prefixed
 * path, or Windows back-slashes; an empty string when the input is blank. Used
 * by `codegraph affected` so `./src/x.ts`, `/abs/repo/src/x.ts`, and
 * `src/x.ts` all match the same indexed file. (#825)
 */
export function normalizeIndexPath(filePath: string, projectPath: string): string {
  let f = filePath.trim();
  if (!f) return '';
  if (path.isAbsolute(f)) f = path.relative(projectPath, f);
  // Collapse `.`/`..` segments, then force forward slashes and drop a leading
  // `./` (path.normalize already strips it on POSIX; explicit for Windows).
  f = path.normalize(f).replace(/\\/g, '/').replace(/^\.\//, '');
  return f;
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\x7D\x7D/g, '.*');
  return new RegExp(escaped);
}

/**
 * Print files as a tree
 */
function printFileTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
  chalk: { dim: (s: string) => string; cyan: (s: string) => string }
): void {
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

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
      }
      console.log(line);
    }

    const children = [...node.children.values()];
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
}

export function registerFileCommands(program: Command): void {


  /**
   * codegraph node [name]
   *
   * The CLI face of the MCP codegraph_node tool: one symbol's source +
   * caller/callee trail, or a whole file with line numbers + dependents
   * (Read-parity). Same subagent/non-MCP rationale as `explore`.
   *
   * `name` is OPTIONAL because `--file` (file-read mode) carries no symbol —
   * a required `<name>` made `codegraph node -f <file>` unreachable (#1044).
   */
  program
    .command('node [name]')
    .description('One symbol\'s source + caller/callee trail, or read a file with line numbers + dependents (same output as the codegraph_node MCP tool)')
    .option('-p, --path <path>', 'Project path')
    .option('-f, --file <file>', 'Treat as file mode (or disambiguate a symbol to this file)')
    .option('--offset <number>', 'File mode: 1-based start line')
    .option('--limit <number>', 'File mode: maximum lines')
    .option('--symbols-only', 'File mode: just the symbol map + dependents')
    .action(async (name: string | undefined, options: { path?: string; file?: string; offset?: string; limit?: string; symbolsOnly?: boolean }) => {
      // Need a symbol (positional) OR a file (--file / a path-like positional).
      // With [name] optional, a bare `codegraph node` reaches here with neither
      // and must be told what to pass, rather than crashing downstream.
      if (!name && !options.file) {
        error("Pass a symbol name (e.g. 'codegraph node parseToken') or a file (e.g. 'codegraph node -f src/auth.ts', or 'codegraph node src/auth.ts').");
        process.exit(1);
      }

      const projectPath = resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph isn't available here — no .codegraph/ index exists in ${projectPath}. If you are an AI agent: continue with your usual tools; indexing is the user's decision, do not run it yourself. (The project owner can enable CodeGraph with 'codegraph init'.)`);
          process.exit(1);
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        const { ToolHandler } = await import('../mcp/tools');
        const handler = new ToolHandler(cg);

        // A name with a path separator is a file read; otherwise a symbol
        // (use --file for basename-only file reads or to pin an overload).
        // Both separators: Windows users type src\auth\session.ts. Symbols
        // never contain either ('/' isn't an identifier char anywhere we
        // index; C++ scope is '::', JS members '.').
        const args: Record<string, unknown> = {};
        if (options.file) {
          args.file = options.file;
          if (name && name !== options.file) {
            args.symbol = name;
            // Symbol mode pinned to a file is still symbol mode — the CLI
            // always wants the body, exactly like the bare-symbol branch
            // below. Omitting this printed location + trail with no source
            // (#1284).
            args.includeCode = true;
          }
        } else if (name && (name.includes('/') || name.includes('\\'))) {
          args.file = name.replace(/\\/g, '/');
        } else if (name) {
          args.symbol = name;
          args.includeCode = true;
        }
        if (options.offset) args.offset = parseInt(options.offset, 10);
        if (options.limit) args.limit = parseInt(options.limit, 10);
        if (options.symbolsOnly) args.symbolsOnly = true;

        const result = await handler.execute('codegraph_node', args);

        console.log(result.content[0]?.text ?? '');
        cg.close();
        if (result.isError) process.exit(1);
      } catch (err) {
        error(`Node lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph files [path]
   */
  program
    .command('files')
    .description('Show project file structure from the index')
    .option('-p, --path <path>', 'Project path')
    .option('--filter \u003Cdir\u003E', 'Filter to files under this directory')
    .option('--pattern <glob>', 'Filter files matching this glob pattern')
    .option('--format <format>', 'Output format (tree, flat, grouped)', 'tree')
    .option('--max-depth <number>', 'Maximum directory depth for tree format')
    .option('--no-metadata', 'Hide file metadata (language, symbol count)')
    .option('-j, --json', 'Output as JSON')
    .action(async (options: {
      path?: string;
      filter?: string;
      pattern?: string;
      format?: string;
      maxDepth?: string;
      metadata?: boolean;
      json?: boolean;
    }) => {
      const projectPath = resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        let files = cg.getFiles();

        if (files.length === 0) {
          info('No files indexed. Run "codegraph index" first.');
          cg.close();
          return;
        }

        // Filter by path prefix
        if (options.filter) {
          const filter = options.filter;
          files = files.filter(f => f.path.startsWith(filter) || f.path.startsWith('./' + filter));
        }

        // Filter by glob pattern
        if (options.pattern) {
          const regex = globToRegex(options.pattern);
          files = files.filter(f => regex.test(f.path));
        }

        if (files.length === 0) {
          info('No files found matching the criteria.');
          cg.close();
          return;
        }

        // JSON output
        if (options.json) {
          const output = files.map(f => ({
            path: f.path,
            language: f.language,
            nodeCount: f.nodeCount,
            size: f.size,
          }));
          console.log(JSON.stringify(output, null, 2));
          cg.close();
          return;
        }

        const includeMetadata = options.metadata !== false;
        const format = options.format || 'tree';
        const maxDepth = options.maxDepth ? parseInt(options.maxDepth, 10) : undefined;

        // Format output
        switch (format) {
          case 'flat':
            console.log(chalk.bold(`\nFiles (${files.length}):\n`));
            for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
              if (includeMetadata) {
                console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
              } else {
                console.log(`  ${file.path}`);
              }
            }
            break;

          case 'grouped':
            console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
            const byLang = new Map<string, typeof files>();
            for (const file of files) {
              const existing = byLang.get(file.language) || [];
              existing.push(file);
              byLang.set(file.language, existing);
            }
            const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
            for (const [lang, langFiles] of sortedLangs) {
              console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
              for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
                if (includeMetadata) {
                  console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
                } else {
                  console.log(`  ${file.path}`);
                }
              }
              console.log();
            }
            break;

          case 'tree':
          default:
            console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
            printFileTree(files, includeMetadata, maxDepth, chalk);
            break;
        }

        console.log();
        cg.close();
      } catch (err) {
        error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
