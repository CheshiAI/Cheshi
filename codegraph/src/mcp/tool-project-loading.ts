// Lazy-load the heavy CodeGraph chain off the MCP startup path — see the same
// helper in engine.ts. ToolHandler must load to answer tools/list (static
// schemas), but it must NOT drag in sqlite/query layers before the daemon binds;
// CodeGraph is pulled in only when a tool actually opens a project. require() is
// synchronous and cached by Bun.
export const loadCodeGraph = (): typeof import('../index').default =>
  loadCodeGraphForTests ?? (require('../index') as typeof import('../index')).default;

// Test seam (same pattern as the watcher's `__setFsWatchForTests`): tests that
// need to control the lazy `require('../index')` above inject the
// in-process tests that exercise a genuine cross-project open (an explicit
// `projectPath` to a different project — issue #1474's repro shape) inject the
// already-imported class here. Never set outside tests.
let loadCodeGraphForTests: typeof import('../index').default | null = null;

export function __setLoadCodeGraphForTests(cls: typeof import('../index').default | null): void {
  loadCodeGraphForTests = cls;
}

/**
 * An expected, recoverable "codegraph can't serve this" condition — most
 * importantly a project with no index. The dispatch catch converts these to
 * SUCCESS-shaped responses (guidance text, NO isError): an `isError: true`
 * early in a session teaches the agent the toolset is broken and it stops
 * calling codegraph entirely (observed repeatedly), which is exactly wrong
 * for conditions the agent can simply work around (use built-in tools for
 * that codebase / pass projectPath). isError is reserved for "stop trying"
 * cases: security refusals ({@link PathRefusalError}) and genuine
 * malfunctions.
 */
export class NotIndexedError extends Error { }

/**
 * A security refusal (sensitive system path). Stays `isError: true` WITHOUT
 * retry guidance — abandoning this path is the desired agent reaction.
 */
export class PathRefusalError extends Error { }
