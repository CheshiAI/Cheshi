import { useCallback, useEffect, useState } from 'react';
import { cheshiDesktop as desktopApi } from '../../cheshiDesktop';

interface CodeGraphIndexSummary {
  fileCount: number;
  nodeCount: number;
  relationshipCount: number;
  lastIndexed: number | null;
}

export type CodeGraphIndexStatus =
  | { state: 'loading'; summary: null; message: null }
  | { state: 'ready'; summary: CodeGraphIndexSummary; message: null }
  | { state: 'not_indexed'; summary: null; message: string }
  | { state: 'error'; summary: null; message: string };

const INITIAL_STATUS: CodeGraphIndexStatus = { state: 'loading', summary: null, message: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isLiteralTrue(value: unknown): value is true {
  return value === true;
}

function assertReindexResponse(value: unknown): asserts value is { reindexed: true } {
  if (!isRecord(value) || !isLiteralTrue(value.reindexed)) {
    throw new Error('CodeGraph returned an invalid reindex response.');
  }
}

function normalizeIndexSummary(value: unknown): CodeGraphIndexSummary | null {
  if (!isRecord(value) || !isRecord(value.stats)) return null;
  const { fileCount, nodeCount, edgeCount } = value.stats;
  if (!isCount(fileCount) || !isCount(nodeCount) || !isCount(edgeCount)) return null;
  if (value.lastIndexed !== null && typeof value.lastIndexed !== 'number') return null;
  if (typeof value.lastIndexed === 'number' && !Number.isFinite(value.lastIndexed)) return null;
  return {
    fileCount,
    nodeCount,
    relationshipCount: edgeCount,
    lastIndexed: value.lastIndexed,
  };
}

async function loadIndexStatus(): Promise<CodeGraphIndexStatus> {
  try {
    if (desktopApi?.isCodeGraphIndexed) {
      const indexed = await desktopApi.isCodeGraphIndexed();
      if (!isLiteralTrue(indexed)) {
        return {
          state: 'not_indexed',
          summary: null,
          message: 'Run cheshi-cli codegraph init to create an index.',
        };
      }
    }

    const response = await fetch('/api/meta', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return {
        state: 'error',
        summary: null,
        message: `Index metadata unavailable (${response.status}).`,
      };
    }
    const summary = normalizeIndexSummary(await response.json());
    if (!summary) {
      return { state: 'error', summary: null, message: 'Index metadata has an invalid format.' };
    }
    return { state: 'ready', summary, message: null };
  } catch (error) {
    return {
      state: 'error',
      summary: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Own status independently of the graph view so startup and pane switches share one load. */
export function useCodeGraphIndex() {
  const [status, setStatus] = useState<CodeGraphIndexStatus>(INITIAL_STATUS);
  const [reindexing, setReindexing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadIndexStatus().then(next => { if (!cancelled) setStatus(next); });
    return () => { cancelled = true; };
  }, []);

  const reindex = useCallback(async () => {
    if (!desktopApi?.reindexCodeGraph || reindexing) return;
    setReindexing(true);
    try {
      assertReindexResponse(await desktopApi.reindexCodeGraph());
      setStatus(await loadIndexStatus());
    } catch (error) {
      setStatus({ state: 'error', summary: null, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setReindexing(false);
    }
  }, [reindexing]);

  return { status, reindexing, busy: status.state === 'loading' || reindexing, reindex };
}

export type CodeGraphIndexController = ReturnType<typeof useCodeGraphIndex>;
