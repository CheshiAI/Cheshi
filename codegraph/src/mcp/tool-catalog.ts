import {
  DEFAULT_MCP_TOOLS,
  type ToolDefinition,
  tools,
  withRequiredProjectPath
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';
import {
  getExploreBudget
} from './tool-options';

/**
   * Optional allowlist of exposed tools, parsed from the CODEGRAPH_MCP_TOOLS
   * env var (comma-separated short names, e.g. "trace,search,node,context").
   * Unset/empty → every tool is exposed. Lets an operator (or an A/B harness)
   * trim the tool surface without rebuilding the client config; the ablated
   * tool is then truly absent from ListTools rather than merely denied on call.
   * Matching is on the short form, so "node" and "codegraph_node" both work.
   */
export function toolAllowlist(this: ToolHandlerState): Set<string> | null {
  const raw = process.env.CODEGRAPH_MCP_TOOLS;
  if (!raw || !raw.trim()) return null;
  const short = (s: string) => s.trim().replace(/^codegraph_/, '');
  const set = new Set(raw.split(',').map(short).filter(Boolean));
  return set.size ? set : null;
}

/** Whether a tool name passes the CODEGRAPH_MCP_TOOLS allowlist (if any). */
export function isToolAllowed(this: ToolHandlerState, name: string): boolean {
  const allow = this.toolAllowlist();
  return !allow || allow.has(name.replace(/^codegraph_/, ''));
}

/**
   * Get tool definitions with dynamic descriptions based on project size.
   * The codegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files. Honors the CODEGRAPH_MCP_TOOLS
   * allowlist so a trimmed surface is reflected in ListTools.
   */
export function getTools(this: ToolHandlerState): ToolDefinition[] {
  const allow = this.toolAllowlist();
  // No explicit allowlist → the default 4-tool surface (see
  // DEFAULT_MCP_TOOLS for the evidence). An allowlist replaces the
  // default entirely, so any defined tool can be re-enabled.
  let visible = allow
    ? tools.filter(t => allow.has(t.name.replace(/^codegraph_/, '')))
    : tools.filter(t => DEFAULT_MCP_TOOLS.has(t.name.replace(/^codegraph_/, '')));
  // No default project loaded → no-root-index case (#993): a gateway server
  // started outside any repo, or a monorepo root whose indexes live in
  // sub-projects. With nothing to fall back to, EVERY call needs an explicit
  // projectPath, so mark it required in the schema — a high-salience nudge the
  // agent acts on, where SERVER_INSTRUCTIONS_NO_ROOT_INDEX's prose alone
  // wasn't enough (the reporter had to add an AGENTS.md note). `this.cg` is
  // settled by `retryInitIfNeeded()` before `handleToolsList` calls us, so a
  // null here means "genuinely no default", not a startup race. When a default
  // IS open we leave projectPath optional (below): a bare call falls back to
  // it, exactly as in the common single-project launch.
  if (!this.cg) return withRequiredProjectPath(visible);

  try {
    const stats = this.cg.getStats();
    const budget = getExploreBudget(stats.fileCount);

    // Tiny-repo tool gating: on projects under TINY_REPO_FILE_THRESHOLD
    // files, only expose the core trio (search, node, explore) — one
    // below even the 4-tool default: at this scale callers, too, reduces
    // to one grep. (Historical note: the audit below ran when context and
    // trace still existed; its "5 core tools" are today's trio.)
    //
    // n=2 audits ruled out cutting below 5 tools:
    // - 3-tool gate (search + context + trace): cost regressed on
    //   cobra/ky/sinatra. The agent fell back to raw Reads to cover
    //   what codegraph_node + codegraph_explore would have answered.
    // - 1-tool gate (search only): catastrophic regression — express
    //   went from -43% WIN to +107% LOSS. With only search, the agent
    //   can't navigate the call graph structurally and reads everything.
    //
    // 5 is the empirical lower bound. Tools beyond search/context/
    // node/explore/trace pay overhead that the agent doesn't recoup
    // on tiny-repo flow questions.
    // ITER4: raise threshold 150 → 500 so single-file frameworks
    // (sinatra at 159, slim_framework around 200) also get the
    // 5-tool surface. The empirical 5-tool floor was set on <150
    // probes; iter3 measurement showed sinatra is structurally the
    // SAME problem as cobra (single-file WITHOUT-arm Read wins),
    // so it deserves the same gating.
    const TINY_REPO_FILE_THRESHOLD = 500;
    const TINY_REPO_CORE_TOOLS = new Set([
      'codegraph_explore',
      'codegraph_search',
      'codegraph_node',
    ]);
    if (stats.fileCount < TINY_REPO_FILE_THRESHOLD) {
      visible = visible.filter(t => TINY_REPO_CORE_TOOLS.has(t.name));
    }

    return visible.map(tool => {
      if (tool.name === 'codegraph_explore') {
        return {
          ...tool,
          description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
        };
      }
      return tool;
    });
  } catch {
    return visible;
  }
}
