import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { CanvasApi, CanvasRestoreRequest } from '../../../../shared/canvas';
import { NeumorphicButton, SidebarPanelHeader } from '../../shared/ui';
import { CanvasVersionHistory } from './CanvasVersionHistory';
import styles from './CanvasSidebar.module.css';

export function CanvasHistoryPanel({ api, path, active, refresh, disabled, onRestore, onClose }: {
  api: Pick<CanvasApi, 'history' | 'readVersion'>; path: string; active: boolean; refresh: number; disabled: boolean;
  onRestore(request: CanvasRestoreRequest): Promise<void>; onClose(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)), []);
  useEffect(() => setError(null), [path, refresh]);
  return <div className={styles.root} aria-label="Canvas history panel">
    <SidebarPanelHeader title="HISTORY" actions={
      <NeumorphicButton variant="ghost" size="icon" aria-label="Close canvas history" title="Close canvas history" onClick={onClose}><X /></NeumorphicButton>
    } />
    <div className={styles.historyBody}>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {path ? <CanvasVersionHistory api={api} path={path} refresh={refresh} active={active} disabled={disabled} onRestore={onRestore} onError={report} />
        : <p className={styles.historyNotice}>Save this canvas to start its history.</p>}
    </div>
    <p className={styles.historyNotice} title="Changed saves are recorded locally. Identical file contents are deduplicated. Git commits are separate.">Recorded on save · Stored on this device</p>
  </div>;
}
