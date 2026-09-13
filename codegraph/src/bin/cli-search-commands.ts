import type { Command } from "commander";
import { extractCodeTokens, hasStructuralKeyword, isInitialized, planFrontload } from '../directory';
import { extractProseCandidates } from '../search/identifier-segments';
import { chalk, error, info } from './cli-output';
import { requireInitializedProject, resolveProjectPath } from './cli-project';
import { loadCodeGraph } from './cli-runtime';

export function registerSearchCommands(program: Command): void {


  /**
   * codegraph query <search>
   */
  program
    .command('query <search>')
    .description('Search for symbols in the codebase')
    .option('-p, --path <path>', 'Project path')
    .option('-l, --limit <number>', 'Maximum results', '10')
    .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
    .option('-j, --json', 'Output as JSON')
    .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean }) => {
      const projectPath = resolveProjectPath(options.path);

      try {
        requireInitializedProject(projectPath);

        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(projectPath);

        const limit = parseInt(options.limit || '10', 10);
        const rawResults = cg.searchNodes(search, {
          limit,
          kinds: options.kind ? [options.kind as any] : undefined,
        });

        // Mirror the MCP search down-rank so the CLI also surfaces the
        // hand-written implementation before protobuf/gRPC scaffolding
        // when both share a name. See extraction/generated-detection.ts.
        const { isGeneratedFile } = await import('../extraction/generated-detection');
        const results = [...rawResults].sort((a, b) => {
          const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
          const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
          return aGen - bGen;
        });

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            info(`No results found for "${search}"`);
          } else {
            console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

            // Results arrive already ranked by relevance, so the order conveys
            // it. We don't print the raw score: it's an unbounded BM25/FTS value
            // (relative-ranking only), and the old `(score * 100)%` rendered it
            // as nonsensical percentages like "12042%" (#1045). The MCP search
            // tool likewise shows no score. Raw `score` stays in --json output.
            for (const result of results) {
              const node = result.node;
              const location = `${node.filePath}:${node.startLine}`;

              console.log(
                chalk.cyan(node.kind.padEnd(12)) +
                chalk.white(node.name)
              );
              console.log(chalk.dim(`  ${location}`));
              if (node.signature) {
                console.log(chalk.dim(`  ${node.signature}`));
              }
              console.log();
            }
          }
        }

        cg.close();
      } catch (err) {
        error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph explore <query...>
   *
   * The CLI face of the MCP codegraph_explore tool — same handler, same
   * output (source of the relevant symbols grouped by file + the call path
   * among them). Exists so agents WITHOUT the MCP tools — Task-tool
   * subagents (which don't inherit MCP tools, #704) and non-MCP harnesses —
   * can reach the graph through a plain shell command.
   */
  program
    .command('explore <query...>')
    .description('Explore an area: relevant symbols\' source + call paths in one shot (same output as the codegraph_explore MCP tool)')
    .option('-p, --path <path>', 'Project path')
    .option('--max-files <number>', 'Maximum number of files to include source from')
    .action(async (queryParts: string[], options: { path?: string; maxFiles?: string }) => {
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

        const args: Record<string, unknown> = { query: queryParts.join(' ') };
        if (options.maxFiles) args.maxFiles = parseInt(options.maxFiles, 10);
        const result = await handler.execute('codegraph_explore', args);

        console.log(result.content[0]?.text ?? '');
        cg.close();
        if (result.isError) process.exit(1);
      } catch (err) {
        error(`Explore failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });


  /**
   * codegraph prompt-hook  (hidden)
   *
   * A Claude Code `UserPromptSubmit` hook entry point. Reads `{prompt, cwd}` JSON
   * on stdin; for a structural/flow/impact prompt it runs `codegraph_explore` on
   * the indexed project and prints the result to stdout, which Claude injects into
   * the agent's context — so the agent's reflex grep/read has nothing left to find
   * and reliably uses CodeGraph (the adoption problem). Installed by the installer
   * into Claude's settings.json (opt-in, default-yes).
   *
   * LOAD-BEARING: this must NEVER break the user's prompt. Every failure path —
   * kill-switch, non-structural prompt, no index, engine error — exits 0 with no
   * output. The only effect is additive context when it can confidently provide it.
   */
  program
    .command('prompt-hook', { hidden: true })
    .description('Claude UserPromptSubmit hook: inject CodeGraph context for structural prompts (reads {prompt,cwd} JSON on stdin)')
    .action(async () => {
      try {
        // Kill-switch: lets a user disable the nudge without uninstalling /
        // editing settings.json (CI, low-power machines, personal preference).
        if (process.env.CODEGRAPH_NO_PROMPT_HOOK === '1' || process.env.CODEGRAPH_PROMPT_HOOK === '0') return;
        if (process.stdin.isTTY) return; // invoked by hand, no piped payload

        const raw = await new Promise<string>((resolve) => {
          let data = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (c) => { data += c; });
          process.stdin.on('end', () => resolve(data));
          process.stdin.on('error', () => resolve(data));
        });

        let input: { prompt?: string; cwd?: string } = {};
        try { input = JSON.parse(raw); } catch { return; }
        const prompt = String(input.prompt || '');

        // Gate, tiered by confidence (#994, #1126):
        //   HIGH   — a structural keyword (any covered language), or a code-shaped
        //            token verified in the index → full explore injection.
        //   MEDIUM — no keyword/token, but prose words match indexed symbol-name
        //            SEGMENTS ("state machine" → OrderStateMachine, in any
        //            language): inject a short list of the matching symbols and
        //            let the AGENT write the explore query — the graph-derived
        //            tier, no vocabulary involved.
        //   silent — nothing verified. Every other prompt ("fix this typo")
        //            stays a zero-cost no-op.
        // Keywords fire on their own; a token or prose word is only a CANDIDATE
        // verified against the graph below, so a tech brand ("JavaScript") that
        // merely looks like code doesn't inject spurious context.
        const keyworded = hasStructuralKeyword(prompt);
        const codeTokens = keyworded ? [] : extractCodeTokens(prompt);
        const proseWords = keyworded ? [] : extractProseCandidates(prompt);
        if (!keyworded && codeTokens.length === 0 && proseWords.length === 0) return;

        // Decide what to inject, shaped by WHERE the index(es) are: the nearest
        // indexed ancestor of cwd, or — when cwd is an un-indexed workspace root
        // whose indexed project(s) live in sub-dirs (the monorepo case, #964) —
        // the sub-project the prompt points at, plus a `projectPath` nudge for any
        // others. Without the down-scan the hook injected nothing at a monorepo
        // root (it only walked up), so the validated adoption lever never fired
        // exactly where the agent most needs it.
        const plan = planFrontload(String(input.cwd || process.cwd()), prompt);
        if (!plan.exploreRoot && plan.nudgeProjects.length === 0) return; // nothing reachable — the agent's normal tools apply

        // A "pass projectPath" line for indexed sub-projects we did NOT front-load.
        // Follow-up codegraph_explore calls against a sub-project (cwd isn't its
        // index root) need an explicit projectPath, so spell it out.
        const nudge = (projects: string[], lead: string): string =>
          `${lead}\n${projects.map((p) => `  - projectPath: "${p}"`).join('\n')}\n`;

        if (plan.exploreRoot) {
          const { default: CodeGraph } = await loadCodeGraph();
          const cg = await CodeGraph.open(plan.exploreRoot);
          try {
            const others = plan.nudgeProjects.length
              ? `\n${nudge(plan.nudgeProjects, 'Other indexed projects in this workspace — pass projectPath to query them:')}`
              : '';

            // Tier decision against THIS index (issue #994 follow-up: candidates
            // must be real here — a brand name or prose about another domain
            // must not inject). Keyword-bearing prompts skip verification — the
            // keyword is signal enough.
            const tokenVerified = !keyworded && codeTokens.some((t) => cg.getNodesByName(t).length > 0);
            if (keyworded || tokenVerified) {
              const { ToolHandler } = await import('../mcp/tools');
              const handler = new ToolHandler(cg);
              const result = await handler.execute('codegraph_explore', { query: prompt });
              const text = result.content[0]?.text ?? '';
              if (!result.isError && text.trim()) {
                // Cap the injection so a large-repo explore can't flood the prompt.
                const MAX = 16000;
                const body = text.length > MAX ? `${text.slice(0, MAX)}\n…(truncated; call codegraph_explore for the rest)` : text;
                // For a front-loaded SUB-project, a follow-up explore needs its path.
                const more = plan.viaSubScan
                  ? `call codegraph_explore with projectPath: "${plan.exploreRoot}" for more`
                  : 'call codegraph_explore for more';
                process.stdout.write(
                  `<codegraph_context note="Structural context from CodeGraph for this prompt — treat returned source as already read; ${more}.">\n${body}${others}\n</codegraph_context>\n`,
                );
              }
              return;
            }

            // MEDIUM: prose words → symbol-name segments, co-occurrence/rarity
            // scored, each hit re-verified to exist (see getSegmentMatches). The
            // payload names the symbols but does NOT run explore — the agent owns
            // the query where the hook's confidence is only "these are related".
            //
            // A database indexed before the vocab table existed starts with it
            // EMPTY, and only sync() backfills it — which this hook never runs
            // (#1142). Heal it here: on a populated vocab this is one SELECT;
            // the actual backfill is a one-time batched pass whose cost the MCP
            // server's own catch-up sync usually pays first (it runs at every
            // session start). A distinct noop outcome keeps a dormant vocab
            // from polluting the noop-unverified recall signal.
            const vocabReady = await cg.healSegmentVocabIfEmpty().catch(() => false);
            if (!vocabReady) return;
            const related = cg.getSegmentMatches(proseWords);
            if (related.length === 0) return;
            const lines = related
              .map((m) => `  - ${m.name} (${m.kind} — ${m.filePath}:${m.startLine})`)
              .join('\n');
            const exampleQuery = related.slice(0, 3).map((m) => m.name).join(' ');
            const projectHint = plan.viaSubScan ? ` with projectPath: "${plan.exploreRoot}"` : '';
            process.stdout.write(
              `<codegraph_context note="CodeGraph found indexed symbols matching this prompt — query the graph before searching files.">\n` +
              `This project's CodeGraph index contains symbols matching this request:\n${lines}\n` +
              `Call codegraph_explore ONCE${projectHint} with the relevant names in one query (e.g. "${exampleQuery}") ` +
              `to get their source, call paths, and blast radius — cheaper and more complete than Read/Grep.\n${others}` +
              `</codegraph_context>\n`,
            );
          } finally {
            cg.close();
          }
        } else {
          // Several indexed sub-projects, none a clear match — don't guess; tell
          // the agent they exist and how to query one.
          process.stdout.write(
            `<codegraph_context note="CodeGraph is available for this workspace's indexed sub-projects — query one by passing projectPath to codegraph_explore.">\n` +
            nudge(plan.nudgeProjects, "This workspace's CodeGraph indexes live in sub-projects. To use CodeGraph, call codegraph_explore with the projectPath of the relevant one:") +
            `</codegraph_context>\n`,
          );
        }
      } catch {
        // Degradable by contract: never surface an error to the prompt pipeline.
      }
    });
}
