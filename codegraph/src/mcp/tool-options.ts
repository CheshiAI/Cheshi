/** Maximum output length to prevent context bloat (characters) */
export const MAX_OUTPUT_LENGTH = 15000;

/**
 * Maximum length for free-form string inputs (query, task, symbol).
 * Bounds memory and CPU when a buggy or hostile MCP client sends a
 * huge payload — without this an attacker could ship a 100MB string
 * and force a full FTS5 scan / OOM the server. 10 000 characters is
 * far beyond any realistic legitimate query.
 */
export const MAX_INPUT_LENGTH = 10_000;

/**
 * Maximum length for path-like string inputs (projectPath, path
 * filter, glob pattern). Paths beyond a few thousand chars are
 * never legitimate and signal abuse or a bug upstream.
 */
export const MAX_PATH_LENGTH = 4_096;

/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
  /** Hard cap on total output characters. */
  maxOutputChars: number;
  /** Default `maxFiles` when the caller didn't specify one. */
  defaultMaxFiles: number;
  /** Cap on contiguous source returned per file (across all its clusters). */
  maxCharsPerFile: number;
  /** Cluster gap threshold in lines — tighter clustering on small projects. */
  gapThreshold: number;
  /** Max symbols listed in the per-file header (``**`path`** — sym(kind), ...``). */
  maxSymbolsInFileHeader: number;
  /** Max edges shown per relationship kind in the Relationships section. */
  maxEdgesPerRelationshipKind: number;
  /** Include the "Relationships" section. */
  includeRelationships: boolean;
  /** Include the "Additional relevant files (not shown)" trailing list. */
  includeAdditionalFiles: boolean;
  /** Include the "Complete source code is included above…" reminder. */
  includeCompletenessSignal: boolean;
  /** Include the explore-budget reminder at the end. */
  includeBudgetNote: boolean;
  /**
   * Hard-drop test/spec/icon/i18n files from the relevant-file set unless
   * the query itself mentions tests. Today they're only deprioritized in
   * the sort, which on tiny repos still lets one slip into the top N (e.g.
   * cobra's `command_test.go` displaced `args.go` and contributed ~10KB of
   * pure noise to "How does cobra parse commands?"). Off by default; on
   * for the very-tiny tier where one slip dominates the budget.
   */
  excludeLowValueFiles: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  // Tiered budget, scaled to project size. The budget is a CEILING (relevance
  // still gates WHAT is included), and it MUST stay under the agent's INLINE
  // tool-result cap (~25K chars). Above that, the host externalizes the result
  // to a file the agent then Reads back — re-introducing a read AND the
  // cache-write cost — which is exactly what a 35K vscode explore did in the
  // n=4 README A/B. So even large repos cap at ~24K: the answer is the handful
  // of ~100-line flow windows the agent would have grep-located and read (it
  // natively reads ~6–9 files, median 100-line ranges), NOT a sprawl of 12
  // files. Concentration onto the flow emerges from this cap + the named-file-
  // first sort dropping peripheral files. Invariant: a larger tier must never
  // get a smaller `maxCharsPerFile` than a smaller tier.
  if (fileCount < 150) {
    return {
      // ITER3: revert iter2's aggressive body shrink (forced Read fallback —
      // the per-file 2.5K cap pushed the agent to Read instead of node).
      // Back to the iter1 shape (13K/4/3.8K) but keep the test-file
      // hard-exclude. The cost lever for this tier lives in steering the
      // agent to stop after 1-2 calls, not in this budget.
      maxOutputChars: 13000,
      defaultMaxFiles: 4,
      maxCharsPerFile: 3800,
      gapThreshold: 7,
      maxSymbolsInFileHeader: 5,
      maxEdgesPerRelationshipKind: 4,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 500) {
    return {
      // ITER3: same revert/keep-filter pattern as <150.
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 5000) {
    return {
      // ~150-line per-file window (the native read unit) × ~6 files, capped at
      // the ~24K inline ceiling so the response is never externalized. Per-file
      // stays ≥ the <500 tier (3800) — monotonic.
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 6500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  // Large + very-large repos: SAME ~24K inline ceiling (a bigger response just
  // externalizes — see vscode). More files indexed → more CALLS via
  // getExploreBudget, not a bigger single response. Per-file 7000 (≥ smaller
  // tiers) gives the central file a ~180-line orientation window.
  if (fileCount < 15000) {
    return {
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  return {
    maxOutputChars: 24000,
    defaultMaxFiles: 8,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
    excludeLowValueFiles: false,
  };
}

/**
 * Whether `codegraph_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `CODEGRAPH_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
export function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== '0';
}

/**
 * Adaptive explore sizing (default ON). `codegraph_explore` skeletonizes OFF-SPINE
 * polymorphic-sibling files — a file whose class is one of ≥3 interchangeable
 * implementations of a shared interface (e.g. OkHttp's `: Interceptor` classes) —
 * to class + member signatures (bodies elided), keeping the on-spine exemplar full.
 * This sizes the response to the answer instead of the budget cap on sibling-heavy
 * flows (OkHttp interceptor-chain explore 28.5k→16.6k, ~28% cheaper than native
 * search, reads flat). It is PROVABLY INERT elsewhere: distinct pipeline steps (no
 * ≥3-implementer supertype, e.g. Excalidraw's `renderStaticScene`) and on-spine
 * files keep full source — output is byte-identical to shipped on excalidraw /
 * tokio / django / vscode / gin. Set `CODEGRAPH_ADAPTIVE_EXPLORE=0` to disable.
 */
export function adaptiveExploreEnabled(): boolean {
  return process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== '0' && process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== 'false';
}

/**
 * How long the FIRST tool call waits on the post-open catch-up reconcile before
 * giving up and serving anyway (issue #905). On a normal repo the reconcile
 * finishes in well under this, so the gate is fully honored and nothing changes.
 * On a very large repo (~100k files) the reconcile takes minutes — blocking the
 * first call on all of it presents as a multi-minute hang — so we wait briefly
 * for a clean answer, then serve and let the reconcile finish in the background
 * (it yields to the event loop, so a concurrent read still runs).
 *
 * `CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS` overrides the default; `0` restores the
 * old unbounded-wait behavior (always block until the reconcile completes).
 */
const DEFAULT_CATCHUP_GATE_TIMEOUT_MS = 3000;

export function resolveCatchUpGateTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  return Math.floor(n);
}
