import * as fs from 'fs';
import { type MaybeYield } from '../resolution/cooperative-yield';
import {
  Edge,
  ExtractionResult,
  FileRecord,
  Language,
  Node,
  UnresolvedReference
} from '../types';
import {
  hashContent
} from './indexing-contracts';
import type { ExtractionState } from './indexing-state';
import { resurrectRefFromDroppedEdge } from './indexing-storage-helpers';
import { finalizeStoreBundle, StoreBundle } from './store-writer';


/**
   * Store extraction result in database
   */
export async function storeExtractionResult(this: ExtractionState, filePath: string, content: string, language: Language, stats: fs.Stats, result: ExtractionResult, onYield?: MaybeYield): Promise<void> {
  // Bulk inserts run in bounded sub-transactions with a yield between, so a
  // giant generated file (tens of thousands of symbols) can't block the
  // event loop — and the #850 watchdog heartbeat — for the whole store.
  // The file was NEVER one atomic transaction (each insert call has its
  // own), and the files-table record still lands last, so crash recovery
  // is unchanged: a partially-stored file has no record and re-indexes.
  const STORE_CHUNK = 2000;
  const contentHash = hashContent(content);

  // Check if file already exists and hasn't changed
  const existingFile = this.queries.getFileByPath(filePath);
  if (existingFile && existingFile.contentHash === contentHash) {
    return; // No changes
  }

  // Snapshot incoming cross-file edges BEFORE deleting this file's nodes.
  // `deleteFile` cascades to delete every edge whose source OR target is a
  // node in this file (edges.FK ... ON DELETE CASCADE). Edges whose SOURCE is
  // in this file are re-emitted by the extractor below, but edges whose SOURCE
  // is in a *different* (unchanged) file are not — they would be silently
  // dropped, which is issue #899: re-indexing a callee file severs `calls`/
  // `references` edges from callers that import it via module-attribute
  // access (`pkg.mod.fn(...)`).
  //
  // We snapshot the edge plus the target node's (name, kind) so we can
  // re-resolve to the re-indexed target's NEW id. Node ids are
  // `sha256(filePath:kind:name:line)`, so any line shift in the callee file
  // (e.g. a docstring-only edit above the symbol) changes every target id and
  // a naive re-insert by old id would silently drop every edge. Matching by
  // (filePath, kind, name) is stable across line shifts; if the symbol was
  // renamed/removed, no match is found and the edge stays dropped (correct).
  const crossFileIncomingEdges = existingFile
    ? this.queries.getCrossFileIncomingEdgesWithTarget(filePath)
    : [];

  // Delete existing data for this file
  if (existingFile) {
    this.queries.deleteFile(filePath);
  }

  // Filter out nodes with missing required fields before insertion.
  // This prevents FK violations when edges reference nodes that would
  // be silently skipped by insertNode() (see issue #42).
  const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);
  const insertedIds = new Set(validNodes.map((n) => n.id));
  const validEdges = result.edges.filter(
    (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
  );
  const validRefs = result.unresolvedReferences
    .filter((ref) => insertedIds.has(ref.fromNodeId))
    .map((ref) => ({
      ...ref,
      filePath: ref.filePath ?? filePath,
      language: ref.language ?? language,
    }));

  // Fast path for the common case (everything fits one chunk): the whole
  // file — nodes, edges, refs, file record — lands in ONE transaction with
  // no event-loop yields in between. Giant generated files keep the chunked
  // + yielding path below so the #850 watchdog heartbeat stays serviced.
  const fitsOneChunk =
    validNodes.length <= STORE_CHUNK &&
    validEdges.length <= STORE_CHUNK &&
    validRefs.length <= STORE_CHUNK;
  if (fitsOneChunk) {
    // Snapshot/re-resolution of cross-file incoming edges (below) still runs
    // for the sync path; on a fresh bulk index crossFileIncomingEdges is [].
    this.queries.storeFileBundle({
      nodes: validNodes,
      edges: validEdges,
      refs: validRefs,
      file: {
        path: filePath,
        contentHash,
        language,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        indexedAt: Date.now(),
        nodeCount: result.nodes.length,
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
    });
    if (crossFileIncomingEdges.length > 0) {
      this.reattachCrossFileEdges(crossFileIncomingEdges, validNodes);
    }
    return;
  }

  // Insert nodes (chunked — see STORE_CHUNK above)
  for (let i = 0; i < validNodes.length; i += STORE_CHUNK) {
    this.queries.insertNodes(validNodes.slice(i, i + STORE_CHUNK));
    await onYield?.();
  }

  // Filter edges to only reference nodes that were actually inserted
  if (validEdges.length > 0) {
    for (let i = 0; i < validEdges.length; i += STORE_CHUNK) {
      this.queries.insertEdges(validEdges.slice(i, i + STORE_CHUNK));
      await onYield?.();
    }
  }

  // Re-insert cross-file incoming edges snapshotted before the delete,
  // re-resolving each edge's target to the re-indexed node's new id by
  // (filePath, kind, name). Node ids include the source line, so any line
  // shift in the callee file (e.g. a docstring-only edit above the symbol)
  // changes every target id and a naive re-insert by old id would drop them
  // all. `insertEdges` still filters to endpoints that exist. This closes
  // the #899 edge-drop on `sync`.
  //
  // Edges whose callee (target) was renamed/removed during the re-index (no
  // match in `newNodesByKindName`) are not silently dropped anymore: each is
  // resurrected as its ORIGINAL unresolved ref (stamped on the edge as
  // metadata.refName/refKind at creation) so the same sync's resolution
  // sweep can rebind it to an alternative definition elsewhere, or park it
  // as status='failed' to be retried when the symbol reappears — the
  // removal-side counterpart of #1240. Edges without refName (built before
  // the stamp existed, or synthesized) still drop silently: reconstructing
  // a ref from the target's plain name would strip receiver/qualifier
  // context and risk a rebind a full re-index would never make.
  if (crossFileIncomingEdges.length > 0) {
    this.reattachCrossFileEdges(crossFileIncomingEdges, validNodes);
  }

  // Insert unresolved references in batch with denormalized filePath/language
  for (let i = 0; i < validRefs.length; i += STORE_CHUNK) {
    this.queries.insertUnresolvedRefsBatch(validRefs.slice(i, i + STORE_CHUNK));
    await onYield?.();
  }

  // Insert file record
  const fileRecord: FileRecord = {
    path: filePath,
    contentHash,
    language,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    indexedAt: Date.now(),
    nodeCount: result.nodes.length,
    errors: result.errors.length > 0 ? result.errors : undefined,
  };
  this.queries.upsertFile(fileRecord);
}

/**
   * Build one file's store bundle for the FRESH-DB path: no existing-file
   * check, no cross-file edge snapshot (both are re-index concerns — a fresh
   * database has neither). Filters mirror storeExtractionResult exactly.
   */
/** The FileRecord for a fresh-index store (nodeCount is the PRE-filter count). */
export function buildFileRecord(this: ExtractionState, filePath: string, content: string, language: Language, stats: fs.Stats, nodeCount: number, resultErrors: ExtractionResult['errors']): FileRecord {
  return {
    path: filePath,
    contentHash: hashContent(content),
    language,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    indexedAt: Date.now(),
    nodeCount,
    errors: resultErrors.length > 0 ? resultErrors : undefined,
  };
}

export function buildFreshStoreBundle(this: ExtractionState, filePath: string, content: string, language: Language, stats: fs.Stats, result: ExtractionResult): StoreBundle {
  return finalizeStoreBundle(
    result,
    filePath,
    language,
    this.buildFileRecord(filePath, content, language, stats, result.nodes.length, result.errors)
  );
}

/**
   * Re-attach cross-file incoming edges snapshotted before a re-index delete
   * (#899): re-resolve each edge's target to the re-indexed node's new id by
   * (kind, name); targets that vanished are resurrected as their original
   * unresolved ref (#1240's removal-side counterpart) when the edge carries
   * its refName stamp.
   */
export function reattachCrossFileEdges(this: ExtractionState, crossFileIncomingEdges: Array<Edge & { targetKind: string; targetName: string; sourceFilePath: string; sourceLanguage: Language }>, validNodes: Node[]): void {
  const newNodesByKindName = new Map<string, string>();
  for (const n of validNodes) {
    newNodesByKindName.set(`${n.kind}\0${n.name}`, n.id);
  }
  const reinserted: Edge[] = [];
  const resurrected: UnresolvedReference[] = [];
  for (const e of crossFileIncomingEdges) {
    const newTargetId = newNodesByKindName.get(`${e.targetKind}\0${e.targetName}`);
    if (newTargetId) {
      reinserted.push({ source: e.source, target: newTargetId, kind: e.kind, metadata: e.metadata, line: e.line, column: e.column, provenance: e.provenance });
    } else {
      const ref = resurrectRefFromDroppedEdge(e);
      if (ref) resurrected.push(ref);
    }
  }
  if (reinserted.length > 0) {
    this.queries.insertEdges(reinserted);
  }
  if (resurrected.length > 0) {
    this.queries.insertUnresolvedRefsBatch(resurrected);
  }
}
