import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph';
import {
  buildCallPathsSection,
  buildContext,
  buildLowConfidenceNote,
  generateSummary,
  getEntryPoints,
  getRelatedFiles,
  resolveImportsToDefinitions,
} from './context-assembly';
import { findRelevantContext } from './context-search';
import { extractCodeBlocks, extractNodeCode, getCode } from './context-source';
import type { ContextBuilder } from './index';

/** Internal state and method bindings for ContextBuilder. */
export class ContextState {
  readonly projectRoot: string;

  readonly queries: QueryBuilder;

  readonly traverser: GraphTraverser;

  constructor(projectRoot: string, queries: QueryBuilder, traverser: GraphTraverser, readonly owner: Pick<ContextBuilder, keyof ContextBuilder> = this) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
  }
}

export interface ContextState {
  buildContext: typeof buildContext;
  buildLowConfidenceNote: typeof buildLowConfidenceNote;
  buildCallPathsSection: typeof buildCallPathsSection;
  findRelevantContext: typeof findRelevantContext;
  getCode: typeof getCode;
  extractNodeCode: typeof extractNodeCode;
  getEntryPoints: typeof getEntryPoints;
  extractCodeBlocks: typeof extractCodeBlocks;
  getRelatedFiles: typeof getRelatedFiles;
  generateSummary: typeof generateSummary;
  resolveImportsToDefinitions: typeof resolveImportsToDefinitions;
}

Object.assign(ContextState.prototype, {
  buildContext,
  buildLowConfidenceNote,
  buildCallPathsSection,
  findRelevantContext,
  getCode,
  extractNodeCode,
  getEntryPoints,
  extractCodeBlocks,
  getRelatedFiles,
  generateSummary,
  resolveImportsToDefinitions,
});
