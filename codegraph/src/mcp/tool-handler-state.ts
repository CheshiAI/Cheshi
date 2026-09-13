import type CodeGraph from '../index';
import {
  type WorktreeIndexMismatch
} from '../sync/worktree';
import type { QueryPool } from './query-pool';
import { getTools, isToolAllowed, toolAllowlist } from './tool-catalog';
import {
  awaitCatchUpGate,
  dispatchTool,
  execute,
  executeReadTool,
  validateOptionalPath,
  validateString,
} from './tool-execution';
import { handleExplore } from './tool-explore';
import {
  boundaryCandidates,
  buildDynamicBoundaries,
  buildFlowFromNamedSymbols,
  buildPolymorphicBoundaries,
  synthEdgeNote,
} from './tool-flow';
import {
  buildContainerOutline,
  edgeLabel,
  errorResult,
  formatImpact,
  formatNodeDetails,
  formatNodeList,
  formatSearchResults,
  textResult,
  truncateOutput,
} from './tool-formatting';
import { isFileStaleOnDisk, withStalenessNotice } from './tool-freshness';
import {
  closeAll,
  freshen,
  getCodeGraph,
  hasDefaultCodeGraph,
  setCatchUpGate,
  setDefaultCodeGraph,
  setDefaultProjectHint,
  setQueryPool,
  withWorktreeNotice,
  worktreeMismatchFor,
} from './tool-project-access';
import {
  formatFilesFlat,
  formatFilesGrouped,
  formatFilesTree,
  globToRegex,
  handleFiles,
  handleStatus,
} from './tool-project-view';
import {
  definitionHeading,
  groupDefinitions,
  handleCallees,
  handleCallers,
  handleImpact,
  handleSearch,
} from './tool-relations';
import { buildBlastRadiusSection, computeGraphRelevance, indirectTestNote } from './tool-relevance';
import {
  formatTrail,
  handleFileView,
  handleNode,
  renderNodeSection,
  renderStaleNodeSection,
} from './tool-source';
import { findAllSymbols, findSymbolMatches, matchesSymbol } from './tool-symbol-lookup';
import type { ToolHandler } from './tools';

/** Internal state and method bindings for ToolHandler. */
export class ToolHandlerState {
  // Cache of opened CodeGraph instances for cross-project queries
  projectCache: Map<string, CodeGraph> = new Map();

  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  defaultProjectHint: string | null = null;

  // Per-start-path cache of the git worktree/index mismatch (issue #155). The
  // mismatch is a fixed property of (where the request came from → which
  // .codegraph/ it resolves to), so the up-to-two `git rev-parse` spawns run
  // once and every later tool call reuses the result — never shelling out to
  // git on the hot path. `undefined` = not computed yet; `null` = no mismatch.
  worktreeMismatchCache: Map<string, WorktreeIndexMismatch | null> = new Map();

  // Gate that the MCP engine pokes after `cg.open()` so the first tool call
  // blocks on the post-open filesystem reconcile (catch-up sync). Without
  // this, a tool call that races past `catchUpSync()` serves rows for files
  // that were deleted (or edited) while no MCP server was running — and the
  // per-file staleness banner can't help, because `getPendingFiles()` is
  // populated by the watcher, not by catch-up. The wait is time-boxed
  // (see {@link resolveCatchUpGateTimeoutMs}) so a minutes-long reconcile on a
  // huge repo can't hang the first call (#905); cleared on first await so
  // subsequent calls don't pay any cost.
  catchUpGate: Promise<void> | null = null;

  // Optional worker-thread pool for off-loop read-tool dispatch (daemon mode).
  // When set + healthy, the heavy read tools run on a worker so the daemon's
  // main loop stays free for the MCP transport under concurrent load. Null in
  // direct/in-process mode (one client, no concurrency to parallelize).
  queryPool: QueryPool | null = null;

  constructor(public cg: CodeGraph | null, readonly owner: Pick<ToolHandler, keyof ToolHandler> = this) { }

  /**
   * Annotate a successful read-tool result with per-file staleness — the
   * non-blocking answer to issue #403. The file watcher tracks every event
   * it sees per path; here we intersect "files referenced in this response"
   * against that pending set and prepend a compact banner so the agent can
   * fall back to Read for those *specific* files without waiting for the
   * debounced sync to fire. Other pending files in the project (not
   * referenced by this response) get a small footer so the agent has a
   * complete picture without bloating the banner.
   *
   * Cost when nothing is pending — the common case — is one boolean check.
   * No I/O, no parsing of markdown beyond a per-pending-file substring scan.
   */
  driftCache = new Map<string, { at: number; stale: boolean }>();
}

export interface ToolHandlerState {
  setQueryPool: typeof setQueryPool;
  setDefaultCodeGraph: typeof setDefaultCodeGraph;
  setCatchUpGate: typeof setCatchUpGate;
  awaitCatchUpGate: typeof awaitCatchUpGate;
  setDefaultProjectHint: typeof setDefaultProjectHint;
  hasDefaultCodeGraph: typeof hasDefaultCodeGraph;
  toolAllowlist: typeof toolAllowlist;
  isToolAllowed: typeof isToolAllowed;
  getTools: typeof getTools;
  getCodeGraph: typeof getCodeGraph;
  freshen: typeof freshen;
  closeAll: typeof closeAll;
  validateString: typeof validateString;
  validateOptionalPath: typeof validateOptionalPath;
  worktreeMismatchFor: typeof worktreeMismatchFor;
  withWorktreeNotice: typeof withWorktreeNotice;
  isFileStaleOnDisk: typeof isFileStaleOnDisk;
  withStalenessNotice: typeof withStalenessNotice;
  execute: typeof execute;
  executeReadTool: typeof executeReadTool;
  dispatchTool: typeof dispatchTool;
  handleSearch: typeof handleSearch;
  groupDefinitions: typeof groupDefinitions;
  definitionHeading: typeof definitionHeading;
  handleCallers: typeof handleCallers;
  handleCallees: typeof handleCallees;
  handleImpact: typeof handleImpact;
  synthEdgeNote: typeof synthEdgeNote;
  buildFlowFromNamedSymbols: typeof buildFlowFromNamedSymbols;
  buildDynamicBoundaries: typeof buildDynamicBoundaries;
  buildPolymorphicBoundaries: typeof buildPolymorphicBoundaries;
  boundaryCandidates: typeof boundaryCandidates;
  buildBlastRadiusSection: typeof buildBlastRadiusSection;
  indirectTestNote: typeof indirectTestNote;
  computeGraphRelevance: typeof computeGraphRelevance;
  handleExplore: typeof handleExplore;
  handleNode: typeof handleNode;
  handleFileView: typeof handleFileView;
  renderNodeSection: typeof renderNodeSection;
  renderStaleNodeSection: typeof renderStaleNodeSection;
  formatTrail: typeof formatTrail;
  handleStatus: typeof handleStatus;
  handleFiles: typeof handleFiles;
  globToRegex: typeof globToRegex;
  formatFilesFlat: typeof formatFilesFlat;
  formatFilesGrouped: typeof formatFilesGrouped;
  formatFilesTree: typeof formatFilesTree;
  matchesSymbol: typeof matchesSymbol;
  findSymbolMatches: typeof findSymbolMatches;
  findAllSymbols: typeof findAllSymbols;
  truncateOutput: typeof truncateOutput;
  formatSearchResults: typeof formatSearchResults;
  formatNodeList: typeof formatNodeList;
  edgeLabel: typeof edgeLabel;
  formatImpact: typeof formatImpact;
  buildContainerOutline: typeof buildContainerOutline;
  formatNodeDetails: typeof formatNodeDetails;
  textResult: typeof textResult;
  errorResult: typeof errorResult;
}

Object.assign(ToolHandlerState.prototype, {
  setQueryPool,
  setDefaultCodeGraph,
  setCatchUpGate,
  awaitCatchUpGate,
  setDefaultProjectHint,
  hasDefaultCodeGraph,
  toolAllowlist,
  isToolAllowed,
  getTools,
  getCodeGraph,
  freshen,
  closeAll,
  validateString,
  validateOptionalPath,
  worktreeMismatchFor,
  withWorktreeNotice,
  isFileStaleOnDisk,
  withStalenessNotice,
  execute,
  executeReadTool,
  dispatchTool,
  handleSearch,
  groupDefinitions,
  definitionHeading,
  handleCallers,
  handleCallees,
  handleImpact,
  synthEdgeNote,
  buildFlowFromNamedSymbols,
  buildDynamicBoundaries,
  buildPolymorphicBoundaries,
  boundaryCandidates,
  buildBlastRadiusSection,
  indirectTestNote,
  computeGraphRelevance,
  handleExplore,
  handleNode,
  handleFileView,
  renderNodeSection,
  renderStaleNodeSection,
  formatTrail,
  handleStatus,
  handleFiles,
  globToRegex,
  formatFilesFlat,
  formatFilesGrouped,
  formatFilesTree,
  matchesSymbol,
  findSymbolMatches,
  findAllSymbols,
  truncateOutput,
  formatSearchResults,
  formatNodeList,
  edgeLabel,
  formatImpact,
  buildContainerOutline,
  formatNodeDetails,
  textResult,
  errorResult,
});
