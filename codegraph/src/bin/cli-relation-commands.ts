import type { Command } from "commander";
import { isInitialized } from '../directory';
import { normalizeIndexPath } from './cli-file-commands';
import { chalk, error, info } from './cli-output';
import { requireInitializedProject, resolveProjectPath } from './cli-project';
import { loadCodeGraph } from './cli-runtime';
import * as fs from 'fs';

/**
 * Shared implementation for the callers/callees CLI commands. The graph
 * traversal and rendering are identical; only the edge direction changes.
 */
async function runSymbolRelationCommand(
  symbol: string,
  options: { path?: string; limit?: string; json?: boolean },
  relation: 'callers' | 'callees',
): Promise<void> {
  const projectPath = resolveProjectPath(options.path);
  try {
    requireInitializedProject(projectPath);
    const { default: CodeGraph } = await loadCodeGraph();
    const cg = await CodeGraph.open(projectPath);
    const limit = parseInt(options.limit || '20', 10);
    const matches = cg.searchNodes(symbol, { limit: 50 });
    if (matches.length === 0) {
      info(`Symbol "${symbol}" not found`);
      cg.close();
      return;
    }

    const getRelated = (nodeId: string) =>
      relation === 'callers' ? cg.getCallers(nodeId) : cg.getCallees(nodeId);
    const seen = new Set<string>();
    const related: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];
    const collect = (nodeId: string): void => {
      for (const item of getRelated(nodeId)) {
        if (seen.has(item.node.id)) continue;
        seen.add(item.node.id);
        related.push({
          name: item.node.name,
          kind: item.node.kind,
          filePath: item.node.filePath,
          startLine: item.node.startLine,
        });
      }
    };

    for (const match of matches) {
      const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
      if (!exactMatch && matches.length > 1) continue;
      collect(match.node.id);
    }
    if (related.length === 0 && matches[0]) collect(matches[0].node.id);

    const limited = related.slice(0, limit);
    const title = relation[0]!.toUpperCase() + relation.slice(1);
    if (options.json) {
      console.log(JSON.stringify({ symbol, [relation]: limited }, null, 2));
    } else if (limited.length === 0) {
      info(`No ${relation} found for "${symbol}"`);
    } else {
      console.log(chalk.bold(`\n${title} of "${symbol}" (${limited.length}):\n`));
      for (const node of limited) {
        const loc = node.startLine ? `:${node.startLine}` : '';
        console.log(chalk.cyan(node.kind.padEnd(12)) + chalk.white(node.name));
        console.log(chalk.dim(`  ${node.filePath}${loc}`));
        console.log();
      }
    }
    cg.close();
  } catch (err) {
    error(`${relation} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function registerRelationCommands(program: Command): void {


  /** codegraph callers <symbol> */
  program
    .command('callers <symbol>')
    .description('Find all functions/methods that call a specific symbol')
    .option('-p, --path <path>', 'Project path')
    .option('-l, --limit <number>', 'Maximum results', '20')
    .option('-j, --json', 'Output as JSON')
    .action((symbol: string, options: { path?: string; limit?: string; json?: boolean }) =>
      runSymbolRelationCommand(symbol, options, 'callers')
    );


  /** codegraph callees <symbol> */
  program
    .command('callees <symbol>')
    .description('Find all functions/methods that a specific symbol calls')
    .option('-p, --path <path>', 'Project path')
    .option('-l, --limit <number>', 'Maximum results', '20')
    .option('-j, --json', 'Output as JSON')
    .action((symbol: string, options: { path?: string; limit?: string; json?: boolean }) =>
      runSymbolRelationCommand(symbol, options, 'callees')
    );


  /**
   * codegraph impact <symbol>
   */
  program
    .command('impact <symbol>')
    .description('Analyze what code is affected by changing a symbol')
    .option('-p, --path <path>', 'Project path')
    .option('-d, --depth <number>', 'Traversal depth', '2')
    .option('-j, --json', 'Output as JSON')
    .action(async (symbol: string, options: { path?: string; depth?: string; json?: boolean }) => {
      const projectPath = resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          process.exit(1);
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        const depth = Math.min(Math.max(parseInt(options.depth || '2', 10), 1), 10);

        const matches = cg.searchNodes(symbol, { limit: 50 });
        if (matches.length === 0) {
          info(`Symbol "${symbol}" not found`);
          cg.close();
          return;
        }

        // Merge impact subgraphs across all exact-matching symbols
        const mergedNodes = new Map<string, { name: string; kind: string; filePath: string; startLine?: number }>();
        const seenEdges = new Set<string>();
        let edgeCount = 0;

        for (const match of matches) {
          const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
          if (!exactMatch && matches.length > 1) continue;
          const impact = cg.getImpactRadius(match.node.id, depth);
          for (const [id, n] of impact.nodes) {
            mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
          }
          for (const e of impact.edges) {
            const key = `${e.source}->${e.target}:${e.kind}`;
            if (!seenEdges.has(key)) {
              seenEdges.add(key);
              edgeCount++;
            }
          }
        }

        // Fallback to top match if exact filter removed everything
        if (mergedNodes.size === 0 && matches[0]) {
          const impact = cg.getImpactRadius(matches[0].node.id, depth);
          for (const [id, n] of impact.nodes) {
            mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
          }
          edgeCount = impact.edges.length;
        }

        if (options.json) {
          console.log(JSON.stringify({
            symbol,
            depth,
            nodeCount: mergedNodes.size,
            edgeCount,
            affected: Array.from(mergedNodes.values()),
          }, null, 2));
        } else if (mergedNodes.size === 0) {
          info(`No affected symbols found for "${symbol}"`);
        } else {
          console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${mergedNodes.size} affected symbols:\n`));

          // Group by file
          const byFile = new Map<string, Array<{ name: string; kind: string; startLine?: number }>>();
          for (const node of mergedNodes.values()) {
            const list = byFile.get(node.filePath) || [];
            list.push({ name: node.name, kind: node.kind, startLine: node.startLine });
            byFile.set(node.filePath, list);
          }

          for (const [file, nodes] of byFile) {
            console.log(chalk.cyan(file));
            for (const node of nodes) {
              const loc = node.startLine ? `:${node.startLine}` : '';
              console.log(`  ${chalk.dim(node.kind.padEnd(12))}${node.name}${chalk.dim(loc)}`);
            }
            console.log();
          }
        }

        cg.close();
      } catch (err) {
        error(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph affected [files...]
   *
   * Find test files affected by the given source files.
   * Traces dependency edges transitively to find test files that depend on changed code.
   *
   * Usage:
   *   git diff --name-only | codegraph affected --stdin
   *   codegraph affected src/lib/components/Editor.svelte src/routes/+page.svelte
   */
  program
    .command('affected [files...]')
    .description('Find test files affected by changed source files')
    .option('-p, --path <path>', 'Project path')
    .option('--stdin', 'Read file list from stdin (one per line)')
    .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
    .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
    .option('-j, --json', 'Output as JSON')
    .option('-q, --quiet', 'Only output file paths, no decoration')
    .action(async (fileArgs: string[], options: { path?: string; stdin?: boolean; depth?: string; filter?: string; json?: boolean; quiet?: boolean }) => {
      const projectPath = resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`CodeGraph not initialized in ${projectPath}`);
          process.exit(1);
        }

        // Collect changed files from args or stdin
        let changedFiles: string[] = [...(fileArgs || [])];

        if (options.stdin) {
          const stdinData = fs.readFileSync(0, 'utf-8');
          const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
          changedFiles.push(...stdinFiles);
        }

        // Normalize inputs to the project-relative, forward-slash form the index
        // stores. Without this, `affected ./src/x.ts`, an absolute path (what a
        // wrapping script often passes), or a Windows back-slash path silently
        // matches nothing and reports 0 affected tests. (#825)
        changedFiles = changedFiles
          .map((f) => normalizeIndexPath(f, projectPath))
          .filter(Boolean);

        if (changedFiles.length === 0) {
          if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
          process.exit(0);
        }

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);
        const maxDepth = parseInt(options.depth || '5', 10);

        // Common test file patterns
        const defaultTestPatterns = [
          /\.spec\./,
          /\.test\./,
          /\/__tests__\//,
          /\/tests?\//,
          /\/e2e\//,
          /\/spec\//,
        ];

        // Custom filter pattern
        let customFilter: RegExp | null = null;
        if (options.filter) {
          // Convert glob to regex: ** → .+, * → [^/]*, . → \.
          const regex = options.filter
            .replace(/[+[\]{}()^$|\\]/g, '\\$&')
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '.+')
            .replace(/\*/g, '[^/]*');
          customFilter = new RegExp(regex);
        }

        function isTestFile(filePath: string): boolean {
          if (customFilter) return customFilter.test(filePath);
          return defaultTestPatterns.some(p => p.test(filePath));
        }

        // BFS to find all transitive dependents of changed files, filtered to test files
        const affectedTests = new Set<string>();
        const allDependents = new Set<string>();

        for (const file of changedFiles) {
          // If the changed file is itself a test file, include it
          if (isTestFile(file)) {
            affectedTests.add(file);
            continue;
          }

          // BFS through dependents
          const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
          const visited = new Set<string>();
          visited.add(file);

          while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth >= maxDepth) continue;

            const dependents = cg.getFileDependents(current.file);
            for (const dep of dependents) {
              if (visited.has(dep)) continue;
              visited.add(dep);
              allDependents.add(dep);

              if (isTestFile(dep)) {
                affectedTests.add(dep);
              } else {
                queue.push({ file: dep, depth: current.depth + 1 });
              }
            }
          }
        }

        const sortedTests = Array.from(affectedTests).sort();

        // Output
        if (options.json) {
          console.log(JSON.stringify({
            changedFiles,
            affectedTests: sortedTests,
            totalDependentsTraversed: allDependents.size,
          }, null, 2));
        } else if (options.quiet) {
          for (const t of sortedTests) console.log(t);
        } else {
          if (sortedTests.length === 0) {
            info('No test files affected by the changed files.');
          } else {
            console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
            for (const t of sortedTests) {
              console.log('  ' + chalk.cyan(t));
            }
            console.log();
          }
        }

        cg.close();
      } catch (err) {
        error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
