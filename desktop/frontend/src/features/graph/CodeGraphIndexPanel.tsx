import { RefreshCw } from 'lucide-react';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import type { CodeGraphIndexController, CodeGraphIndexStatus } from './useCodeGraphIndex';
import styles from './CodeGraphIndexPanel.module.css';

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

export function CodeGraphReindexButton({ index }: { index: CodeGraphIndexController }) {
  return <TooltipButton variant="ghost" size="icon" aria-label="Reindex CodeGraph" title="Reindex CodeGraph"
    disabled={index.busy || index.status.state === 'not_indexed'} onClick={() => void index.reindex()}>
    <RefreshCw className={index.reindexing ? styles.spinning : undefined} aria-hidden="true" />
  </TooltipButton>;
}

export function CodeGraphIndexPanel({ index }: { index: CodeGraphIndexController }) {
  const { status, reindexing, busy } = index;
  const surface = useAutoHideScrollbars<HTMLElement>();
  const indexedAt = status.summary ? indexedAtDetails(status.summary.lastIndexed) : null;
  return (
    <section ref={surface} className={styles.panel} aria-label="CodeGraph index status">
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
