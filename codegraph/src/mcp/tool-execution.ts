import { finalizeExploreResponse } from './explore-source';
import {
  type ReadToolResult,
  type ToolResult
} from './tool-definitions';
import type { ToolHandlerState } from './tool-handler-state';
import {
  MAX_INPUT_LENGTH,
  MAX_PATH_LENGTH,
  resolveCatchUpGateTimeoutMs
} from './tool-options';
import { NotIndexedError, PathRefusalError } from './tool-project-loading';

/**
   * Await the catch-up gate, but no longer than the configured timeout (#905).
   * If the reconcile settles first, we got the fully-reconciled answer. If the
   * timeout wins, we serve the call now and let the reconcile finish in the
   * background — it yields to the event loop (see SYNC_RECONCILE_YIELD_INTERVAL),
   * so a concurrent read still runs against the same connection. Never throws:
   * a failed reconcile is logged by the engine, and we serve best-effort over
   * the same potentially-stale data the un-gated path would have.
   */
export async function awaitCatchUpGate(this: ToolHandlerState, gate: Promise<void>): Promise<void> {
  const timeoutMs = resolveCatchUpGateTimeoutMs();
  if (timeoutMs <= 0) {
    // 0 = opt back into the original unbounded wait.
    try { await gate; } catch { /* engine already logged */ }
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      gate.then(() => 'done' as const, () => 'done' as const),
      timedOut,
    ]);
    if (outcome === 'timeout') {
      process.stderr.write(
        `[CodeGraph MCP] Catch-up reconcile still running after ${timeoutMs}ms; serving this tool call now and finishing the reconcile in the background (#905). ` +
        `Set CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0 to always wait for it.\n`
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
   * Validate that a value is a non-empty string within length bounds.
   *
   * The `maxLength` cap protects against MCP clients that ship huge
   * payloads (10MB+ query strings either by accident or maliciously).
   * Without this, a single oversized input can pin the FTS5 index or
   * exhaust memory before any real work runs.
   */
export function validateString(this: ToolHandlerState, value: unknown, name: string, maxLength: number = MAX_INPUT_LENGTH): string | ToolResult {
  if (typeof value !== 'string' || value.length === 0) {
    return this.errorResult(`${name} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    return this.errorResult(
      `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
    );
  }
  return value;
}

/**
   * Validate an optional path-like string input. Returns the value if
   * valid (or undefined), or a ToolResult with the error.
   */
export function validateOptionalPath(this: ToolHandlerState, value: unknown, name: string): string | undefined | ToolResult {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    return this.errorResult(`${name} must be a string`);
  }
  if (value.length > MAX_PATH_LENGTH) {
    return this.errorResult(
      `${name} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`
    );
  }
  return value;
}

/**
   * Execute a tool by name
   */
export async function execute(this: ToolHandlerState, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    // Block the first tool call on the engine's post-open reconcile so we
    // never serve rows for files deleted/edited while no MCP server was
    // running. The wait is time-boxed (#905): a huge-repo reconcile takes
    // minutes, and blocking the first call on all of it reads as a hang, so
    // we wait briefly then serve and let it finish in the background. The
    // gate is cleared after first await — subsequent calls pay nothing.
    // Catch-up failures are logged by the engine; we proceed regardless so a
    // transient sync error never breaks tools.
    if (this.catchUpGate) {
      const gate = this.catchUpGate;
      this.catchUpGate = null;
      await this.awaitCatchUpGate(gate);
    }
    // Honor the optional tool allowlist (CODEGRAPH_MCP_TOOLS): a trimmed
    // surface rejects ablated tools defensively even if a client cached them.
    if (!this.isToolAllowed(toolName)) {
      return this.errorResult(`Tool ${toolName} is disabled via CODEGRAPH_MCP_TOOLS`);
    }
    // Cross-cutting input validation. All tools accept an optional
    // `projectPath` and most accept either `query`, `task`, or
    // `symbol` — bound their lengths centrally so individual handlers
    // can stay focused on tool-specific logic.
    const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
    if (typeof pathCheck === 'object' && pathCheck !== undefined) {
      return pathCheck;
    }
    // The `path` and `pattern` properties used by codegraph_files are
    // also path-shaped — apply the same cap.
    if (args.path !== undefined) {
      const check = this.validateOptionalPath(args.path, 'path');
      if (typeof check === 'object' && check !== undefined) return check;
    }
    if (args.pattern !== undefined) {
      const check = this.validateOptionalPath(args.pattern, 'pattern');
      if (typeof check === 'object' && check !== undefined) return check;
    }

    // codegraph_status reports watcher state (pending files, degraded mode,
    // worktree warning) and embeds its own sections — it must run on the MAIN
    // thread against the watched default instance, so it is NEVER off-loaded to
    // a worker (whose read connection has no watcher). It also skips the
    // auto-banner wrapper to avoid duplicating its own pending-files section.
    if (toolName === 'codegraph_status') {
      return await this.handleStatus(args);
    }

    // Read tools: off-load the CPU-heavy dispatch to the worker pool when one
    // is attached, healthy, AND has finished its first cold start (daemon
    // mode), so the daemon's single event loop stays free for the MCP
    // transport under concurrent load — otherwise N concurrent explores
    // serialize AND starve the transport until the whole batch drains
    // (clients then time out). Before the first worker is warm, calls run
    // in-process: a call queued behind a cold start sat invisible until the
    // 45s busy backstop — the daemon's first tool call stalling for however
    // long a worker spawn takes on a loaded machine (the #662 flake). With
    // no pool (direct mode) or a degraded one, dispatch runs in-process
    // exactly as before. Either way the result flows through the
    // cross-cutting notices — worktree-index mismatch (#155) and per-file
    // staleness (#403) — which need the watched MAIN instance and so are
    // always applied here, never in the worker.
    const result = (this.queryPool && this.queryPool.healthy && this.queryPool.ready)
      ? await this.queryPool.run(toolName, args)
      : await this.owner.executeReadTool(toolName, args);
    const { exploreSource, ...publicResult } = result;
    const withWorktree = this.withWorktreeNotice(publicResult, args.projectPath as string | undefined);
    const decorated = this.withStalenessNotice(withWorktree, args.projectPath as string | undefined);
    if (!exploreSource) return decorated;
    const [head, ...tail] = decorated.content;
    const source = publicResult.content[0];
    if (!head || !source) return decorated;
    return {
      ...decorated,
      content: [{ type: 'text', text: finalizeExploreResponse(source.text, head.text, exploreSource) }, ...tail],
    };
  } catch (err) {
    // Expected condition, not a malfunction: answer as a SUCCESS so the
    // agent keeps trusting the toolset for projects that ARE indexed.
    // (An isError here teaches session-long abandonment — see NotIndexedError.)
    if (err instanceof NotIndexedError) {
      return this.textResult(err.message);
    }
    // Security refusal: a clean error, no retry encouragement.
    if (err instanceof PathRefusalError) {
      return this.errorResult(err.message);
    }
    return this.errorResult(
      `Tool execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This is an internal codegraph error — retry the call once; if it persists, ' +
      'continue without codegraph for this task.'
    );
  }
}

/**
   * Run a single read tool to completion and return its raw {@link ReadToolResult},
   * classifying expected failures the same way {@link execute}'s catch does so
   * the SHAPE is identical whether dispatch runs in-process or on a worker:
   * NotIndexed → success-shaped guidance, PathRefusal → clean error, anything
   * else → internal-error-with-retry. Never throws.
   *
   * This is the worker thread's entry point (see {@link ./query-worker}) and the
   * in-process fallback for {@link execute}. It deliberately does NOT run the
   * catch-up gate or the staleness/worktree notices — those need the daemon's
   * watched main instance and stay on the main thread. Cross-cutting allowlist +
   * path validation already ran in {@link execute} before routing here.
   */
export async function executeReadTool(this: ToolHandlerState, toolName: string, args: Record<string, unknown>): Promise<ReadToolResult> {
  try {
    return await this.dispatchTool(toolName, args);
  } catch (err) {
    if (err instanceof NotIndexedError) {
      return this.textResult(err.message);
    }
    if (err instanceof PathRefusalError) {
      return this.errorResult(err.message);
    }
    return this.errorResult(
      `Tool execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This is an internal codegraph error — retry the call once; if it persists, ' +
      'continue without codegraph for this task.'
    );
  }
}

/**
   * Pure dispatch over the read tools — the switch, with no gate, no notices, no
   * allowlist/validation (the caller owns those). `codegraph_status` is handled
   * on the main thread in {@link execute} and never reaches here. May throw
   * NotIndexed/PathRefusal, which {@link executeReadTool} classifies.
   */
export async function dispatchTool(this: ToolHandlerState, toolName: string, args: Record<string, unknown>): Promise<ReadToolResult> {
  switch (toolName) {
    case 'codegraph_search': return await this.handleSearch(args);
    case 'codegraph_callers': return await this.handleCallers(args);
    case 'codegraph_callees': return await this.handleCallees(args);
    case 'codegraph_impact': return await this.handleImpact(args);
    case 'codegraph_explore': return await this.handleExplore(args);
    case 'codegraph_node': return await this.handleNode(args);
    case 'codegraph_files': return await this.handleFiles(args);
    default: return this.errorResult(`Unknown tool: ${toolName}`);
  }
}
