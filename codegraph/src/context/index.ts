import { QueryBuilder } from '../db/queries';
import { ContextState } from './context-state';
import { GraphTraverser } from '../graph';
import {
  BuildContextOptions,
  FindRelevantContextOptions,
  Subgraph,
  TaskContext,
  TaskInput
} from '../types';








export { LOW_CONFIDENCE_MARKER } from './markers';

export { formatContextAsJson, formatContextAsMarkdown } from './formatter';

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private readonly state: ContextState;

  constructor(projectRoot: string, queries: QueryBuilder, traverser: GraphTraverser) {
    this.state = new ContextState(projectRoot, queries, traverser, this);
  }



  async buildContext(input: TaskInput, options: BuildContextOptions = {}): Promise<TaskContext | string> {
    return this.state.buildContext(input, options);
  }

  async findRelevantContext(query: string, options: FindRelevantContextOptions = {}): Promise<Subgraph> {
    return this.state.findRelevantContext(query, options);
  }

  async getCode(nodeId: string): Promise<string | null> {
    return this.state.getCode(nodeId);
  }
}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser);
}
