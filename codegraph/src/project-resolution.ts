import type { CodeGraphState } from './project-state';
import { ResolutionResult } from './resolution';

// ===========================================================================
// Reference Resolution
// ===========================================================================

/**
 * Resolve unresolved references and create edges
 *
 * This method takes unresolved references from extraction and attempts
 * to resolve them using multiple strategies:
 * - Framework-specific patterns (React, Express, Laravel)
 * - Import-based resolution
 * - Name-based symbol matching
 */
export function resolveReferences(this: CodeGraphState, onProgress?: (current: number, total: number) => void): ResolutionResult {
  this.assertWritable('resolve references');
  // Get all unresolved references from the database
  const unresolvedRefs = this.queries.getUnresolvedReferences();
  return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
}

/**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
export async function resolveReferencesBatched(this: CodeGraphState, onProgress?: (current: number, total: number) => void, onSynthesisProgress?: (done: number, total: number) => void, backpressure?: () => Promise<void> | null): Promise<ResolutionResult> {
  this.assertWritable('resolve references');
  return this.resolver.resolveAndPersistBatched(onProgress, undefined, onSynthesisProgress, {
    dbPath: this.db.getPath(),
    // Bulk-edge-load hooks: on big runs the resolver drops the non-unique
    // edge indexes for the batch loop and recreates them before synthesis
    // (which reads kind-keyed). Concurrent readers (a daemon serving this
    // project mid-index) stay CORRECT during the window — target/kind reads
    // just degrade to scans until the recreate.
    bulkEdgeLoad: {
      begin: () => this.db.beginBulkEdgeLoad(),
      end: () => this.db.endBulkEdgeLoad(),
    },
    refIndexLoad: {
      begin: () => this.db.beginBulkRefLoad(),
      end: () => this.db.endBulkRefLoad(),
    },
    backpressure,
  });
}

/**
   * References extracted but never attempted by a resolution pass. Zero on a
   * healthy index — a completed pass consumes every pending row (resolving it
   * or parking it as failed, #1240). Non-zero at rest means a pass was
   * interrupted mid-run (killed indexer, crash — #1187), so some files' call
   * edges are missing; the next `sync` sweeps them.
   */
export function getPendingReferenceCount(this: CodeGraphState): number {
  return this.queries.getUnresolvedReferencesCount();
}

/**
   * Get detected frameworks in the project
   */
export function getDetectedFrameworks(this: CodeGraphState): string[] {
  return this.resolver.getDetectedFrameworks();
}

/**
   * Re-initialize the resolver (useful after adding new files)
   */
export function reinitializeResolver(this: CodeGraphState): void {
  this.resolver.initialize();
}
