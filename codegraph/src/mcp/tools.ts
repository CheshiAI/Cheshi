import { ToolHandlerState } from './tool-handler-state';
import type CodeGraph from '../index';
import type { QueryPool } from './query-pool';
import {
  type ReadToolResult,
  type ToolDefinition,
  type ToolResult
} from './tool-definitions';








export { __setLoadCodeGraphForTests } from './tool-project-loading';

export { NotIndexedError } from './tool-project-loading';

export { PathRefusalError } from './tool-project-loading';

export { normalizeQuerySpelling } from './tool-symbol-utils';

export { getExploreBudget } from './tool-options';

export type { ExploreOutputBudget } from './tool-options';

export { getExploreOutputBudget } from './tool-options';

export { formatStaleBanner } from './tool-messages';

export { formatStaleFooter } from './tool-messages';

export { formatDegradedBanner } from './tool-messages';

export type { ToolDefinition } from './tool-definitions';

export type { ToolAnnotations } from './tool-definitions';

export type { ToolResult } from './tool-definitions';

export type { ReadToolResult } from './tool-definitions';

export { tools } from './tool-definitions';

export { getStaticTools } from './tool-definitions';

/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  private readonly state: ToolHandlerState;

  constructor(cg: CodeGraph | null) {
    this.state = new ToolHandlerState(cg, this);
  }

  setQueryPool(pool: QueryPool | null): void {
    return this.state.setQueryPool(pool);
  }

  setDefaultCodeGraph(cg: CodeGraph): void {
    return this.state.setDefaultCodeGraph(cg);
  }

  setCatchUpGate(p: Promise<void> | null): void {
    return this.state.setCatchUpGate(p);
  }

  setDefaultProjectHint(searchedPath: string): void {
    return this.state.setDefaultProjectHint(searchedPath);
  }

  hasDefaultCodeGraph(): boolean {
    return this.state.hasDefaultCodeGraph();
  }

  getTools(): ToolDefinition[] {
    return this.state.getTools();
  }

  closeAll(): void {
    return this.state.closeAll();
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.state.execute(toolName, args);
  }

  async executeReadTool(toolName: string, args: Record<string, unknown>): Promise<ReadToolResult> {
    return this.state.executeReadTool(toolName, args);
  }
}
