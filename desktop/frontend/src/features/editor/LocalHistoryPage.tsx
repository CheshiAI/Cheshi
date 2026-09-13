import { ArrowLeft, History, PanelRight, RotateCcw, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  LOCAL_HISTORY_MAX_BYTES, LOCAL_HISTORY_RETENTION_DAYS, type LocalHistoryReason,
} from '../../../../shared/local-history';
import { cheshiDesktop, type WorkspaceFileWriteResult } from '../../cheshiDesktop';
import {
  NeumorphicButton, TieredHeader, draggableWindowRegionStyle, nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { localHistoryDiff } from './localHistoryDiff';
import { LocalHistoryModel } from './localHistoryModel';
import styles from './LocalHistoryPage.module.css';

interface LocalHistoryPageProps {
  path: string;
  draftDirty?: boolean;
  onClose(): void;
  onRestored?(result: WorkspaceFileWriteResult): void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar(): void;
}

const reasonLabels: Record<LocalHistoryReason, string> = {
  opened: 'Original contents',
  saved: 'Saved',
  external: 'External change',
  'before-restore': 'Before restore',
  restored: 'Restored',
};

const formatDate = (timestamp: number): string => new Date(timestamp).toLocaleString(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function LocalHistoryPage({
  path, draftDirty = false, onClose, onRestored, rightSidebarOpen, onToggleRightSidebar,
}: LocalHistoryPageProps) {
  const model = useMemo(() => new LocalHistoryModel(
    path, cheshiDesktop?.localHistory ? cheshiDesktop : undefined,
  ), [path]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const { entries, selectedId, snapshot, current, loading, loadingSnapshot, restoring, error, notice } = state;
  const comparison = useMemo(() => snapshot && current?.content !== null && current?.content !== undefined
    ? localHistoryDiff(snapshot.content, current.content) : null, [snapshot, current]);

  useEffect(() => {
    model.start();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = cheshiDesktop?.onWorkspaceFilesChanged((event) => {
      if (!event.overflow && !event.paths.includes(path)) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void model.refresh(); }, 200);
    });
    return () => {
      clearTimeout(refreshTimer);
      unsubscribe?.();
      model.dispose();
    };
  }, [model, path]);

  const identical = snapshot !== null && current !== null && snapshot.content === current.content
    && snapshot.hasBom === current.file.hasBom && snapshot.lineEnding === current.file.lineEnding;
  const canRestore = snapshot !== null && current?.file.fileKind === 'text'
    && !loading && !loadingSnapshot && !restoring && !draftDirty && !identical;
  const restore = async (): Promise<void> => {
    const result = await model.restore(draftDirty);
    if (result?.status === 'written') onRestored?.(result);
  };

  return (
    <main className={styles.workspace} aria-label="Local history workspace">
      <TieredHeader className={styles.header} style={draggableWindowRegionStyle} primary={(
        <>
          <div className={styles.title}>
            <NeumorphicButton raised className={`theme-toggle ${styles.titleMark}`} disabled aria-hidden="true">
              <History size={11} strokeWidth={1.7} aria-hidden="true" />
            </NeumorphicButton>
            <h1>Local history</h1>
          </div>
          <span className={styles.path} title={path}>{path}</span>
          <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
            <NeumorphicButton raised size="icon" aria-label="Back from local history"
              title="Back" disabled={restoring} onClick={onClose}>
              <ArrowLeft aria-hidden="true" />
            </NeumorphicButton>
            <NeumorphicButton raised size="icon" aria-label="Refresh local history" aria-busy={loading}
              title="Refresh local history" disabled={loading || restoring} onClick={() => void model.refresh()}>
              <RotateCw aria-hidden="true" />
            </NeumorphicButton>
            <NeumorphicButton raised size="icon" onClick={onToggleRightSidebar}
              aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
              aria-expanded={rightSidebarOpen}>
              <PanelRight aria-hidden="true" />
            </NeumorphicButton>
          </div>
        </>
      )} />
      <div className={styles.layout}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {draftDirty && <p className={styles.notice}>
          This file has unsaved edits. Save it before restoring. The comparison shows the saved file on disk.
        </p>}
        <div className={styles.body} aria-busy={loading || loadingSnapshot}>
          <nav className={styles.history} aria-label="Saved file versions">
            {loading && entries.length === 0 ? <p role="status">Loading history…</p>
              : entries.length === 0 ? <p>No saved versions yet.</p> : entries.map((entry) => (
                <button key={entry.id} type="button" className={styles.entry}
                  aria-current={entry.id === selectedId ? 'true' : undefined}
                  disabled={loading || restoring} onClick={() => void model.select(entry.id)}>
                  <span>{reasonLabels[entry.reason]}</span>
                  <time dateTime={new Date(entry.createdAt).toISOString()}>{formatDate(entry.createdAt)}</time>
                </button>
              ))}
          </nav>
          <section className={styles.comparison} aria-label="Version comparison">
            {loadingSnapshot ? <p className={styles.empty} role="status">Loading version…</p>
              : comparison && snapshot && current ? <>
                <div className={styles.columns}>
                  <div>Selected snapshot · {formatDate(snapshot.entry.createdAt)}
                    <small>{snapshot.lineEnding.toUpperCase()}{snapshot.hasBom ? ' · UTF-8 BOM' : ' · UTF-8'}</small>
                  </div>
                  <div>Current saved file
                    <small>{current.file.lineEnding.toUpperCase()}{current.file.hasBom ? ' · UTF-8 BOM' : ' · UTF-8'}</small>
                  </div>
                </div>
                {identical && <p className={styles.notice}>This version matches the current saved file.</p>}
                {comparison.simplified && <p className={styles.notice}>
                  Large changes are shown as a replacement block.
                </p>}
                <div className={styles.diff} role="table" aria-label="Selected version and current saved file">
                  {comparison.rows.map((row, index) => (
                    <div className={styles.diffRow} role="row" key={index}>
                      <div className={styles.cell} role="cell" data-kind={row.changed && row.previous ? 'removed' : undefined}>
                        <span className={styles.lineNumber}>{row.previous?.number}</span>
                        <span className={styles.marker} aria-hidden="true">{row.changed && row.previous ? '−' : ''}</span>
                        <code>{row.previous?.text ?? ' '}</code>
                      </div>
                      <div className={styles.cell} role="cell" data-kind={row.changed && row.current ? 'added' : undefined}>
                        <span className={styles.lineNumber}>{row.current?.number}</span>
                        <span className={styles.marker} aria-hidden="true">{row.changed && row.current ? '+' : ''}</span>
                        <code>{row.current?.text ?? ' '}</code>
                      </div>
                    </div>
                  ))}
                  {comparison.rows.length === 0 && <p className={styles.empty}>Both versions are empty.</p>}
                  {comparison.truncated && <p className={styles.notice}>Showing the first 10,000 lines of the comparison.</p>}
                </div>
              </> : <div className={styles.empty}>
                <History aria-hidden="true" />
                <p>{entries.length ? 'Select a version to compare.' : 'Your file history starts here.'}</p>
                <p>Text files are recorded when opened or saved. Later detected external changes are recorded too.</p>
              </div>}
          </section>
        </div>
        <footer className={styles.footer}>
          <p>Stored on this device · Up to {LOCAL_HISTORY_RETENTION_DAYS} days / {LOCAL_HISTORY_MAX_BYTES / 1024 / 1024}
            {' '}MiB per workspace. Git commits stay unchanged.</p>
          <NeumorphicButton raised size="standard" disabled={!canRestore} aria-busy={restoring}
            title={draftDirty ? 'Save your edits before restoring' : 'Restore this version and keep the current contents in history'}
            onClick={() => void restore()}>
            <RotateCcw aria-hidden="true" />{restoring ? 'Restoring…' : 'Restore this version'}
          </NeumorphicButton>
        </footer>
      </div>
    </main>
  );
}
