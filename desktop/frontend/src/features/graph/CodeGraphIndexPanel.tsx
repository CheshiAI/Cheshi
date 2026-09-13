import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { NeumorphicButton } from '../../shared/ui';
import { cheshiDesktop as desktopApi } from '../../cheshiDesktop';
import styles from './CodeGraphIndexPanel.module.css';

interface CodeGraphIndexSummary {
  fileCount: number;
  nodeCount: number;
  relationshipCount: number;
  lastIndexed: number | null;
}

type CodeGraphIndexStatus =
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

function indexedAtDetails(value: number | null): { label: string; dateTime?: string } {
  if (value === null) return { label: 'Index time unavailable' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { label: 'Index time unavailable' };
  return {
    label: `Indexed ${new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)}`,
    dateTime: date.toISOString(),
  };
}

function statusLabel(status: CodeGraphIndexStatus, reindexing: boolean): string {
  if (reindexing) return 'INDEXING';
  switch (status.state) {
    case 'loading': return 'CHECKING';
    case 'ready': return 'indexed';
    case 'not_indexed': return 'NOT INDEXED';
    case 'error': return 'UNAVAILABLE';
  }
}

export interface CodeGraphIndexIndicator {
  label: string;
  attention: boolean;
  busy: boolean;
}

export function CodeGraphIndexPanel({ onInitialLoad, onStatusChange }: {
  onInitialLoad?: () => void;
  onStatusChange?: (indicator: CodeGraphIndexIndicator) => void;
} = {}) {
  const [status, setStatus] = useState<CodeGraphIndexStatus>(INITIAL_STATUS);
  const [reindexing, setReindexing] = useState(false);
  useEffect(() => { if (status.state !== 'loading') onInitialLoad?.(); }, [status.state, onInitialLoad]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    setStatus(await loadIndexStatus());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadIndexStatus().then((nextStatus) => {
      if (!cancelled) setStatus(nextStatus);
    });
    return () => { cancelled = true; };
  }, []);

  const reindex = async (): Promise<void> => {
    if (!desktopApi?.reindexCodeGraph || reindexing) return;
    setReindexing(true);
    try {
      const result = await desktopApi.reindexCodeGraph();
      assertReindexResponse(result);
      await refreshStatus();
    } catch (error) {
      setStatus({
        state: 'error',
        summary: null,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReindexing(false);
    }
  };

  const indexedAt = status.summary ? indexedAtDetails(status.summary.lastIndexed) : null;
  const busy = status.state === 'loading' || reindexing;
  useEffect(() => {
    onStatusChange?.({
      label: statusLabel(status, reindexing),
      attention: status.state === 'error' || status.state === 'not_indexed',
      busy,
    });
  }, [status, reindexing, busy, onStatusChange]);

  return (
    <section className={styles.panel} aria-label="CodeGraph index status">
      <header className={styles.heading}>
        <span className={styles.headingLabel}>CODEGRAPH INDEX</span>
        <NeumorphicButton
          raised
          className={`sidebar-heading-action ${styles.refreshButton}`}
          aria-label="Reindex CodeGraph"
          title="Reindex CodeGraph"
          disabled={busy || status.state === 'not_indexed'}
          onClick={() => void reindex()}
        >
          <RefreshCw className={reindexing ? styles.spinning : undefined} aria-hidden="true" />
        </NeumorphicButton>
      </header>
      <div className={styles.rows} aria-busy={busy}>
        <div className={styles.row}>
          {indexedAt
            ? <time className={styles.indexedAt} dateTime={indexedAt.dateTime}>{indexedAt.label}</time>
            : <span>Last indexed</span>}
          <strong className={styles.statusValue} data-state={status.state}>{statusLabel(status, reindexing)}</strong>
        </div>
        {status.summary && (
          <>
            <div className={styles.row}><span>Files</span><strong>{status.summary.fileCount.toLocaleString('en-US')}</strong></div>
            <div className={styles.row}><span>Nodes</span><strong>{status.summary.nodeCount.toLocaleString('en-US')}</strong></div>
            <div className={styles.row}><span>Relationships</span><strong>{status.summary.relationshipCount.toLocaleString('en-US')}</strong></div>
          </>
        )}
      </div>
      {status.message && <p className={styles.detail} role={status.state === 'error' ? 'alert' : undefined}>{status.message}</p>}
    </section>
  );
}
