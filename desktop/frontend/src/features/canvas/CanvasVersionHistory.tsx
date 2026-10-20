import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { CanvasApi, CanvasRestoreRequest, CanvasVersionHistory as VersionHistory } from '../../../../shared/canvas';
import { LiquidGlassPanel, Modal, NeumorphicButton } from '../../shared/ui';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import styles from './CanvasSidebar.module.css';
import { canvasVersionPreview } from './canvasVersionPreview';

export function CanvasVersionHistory({ api, path, refresh, disabled, active = true, onRestore, onError }: {
  api: Pick<CanvasApi, 'history' | 'readVersion'>; path: string; refresh: number; disabled: boolean; active?: boolean;
  onRestore(request: CanvasRestoreRequest): Promise<void>; onError(error: unknown): void;
}) {
  const [history, setHistory] = useState<VersionHistory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const scroll = useAutoHideScrollbars<HTMLElement>();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setHistory(null); setSelected(null); setConfirm(false); setLoading(true);
    void api.history(path).then(value => { if (!cancelled) setHistory(value); })
      .catch(error => { if (!cancelled) onError(error); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, path, refresh, onError, active]);
  useEffect(() => {
    let cancelled = false, url: string | null = null;
    setPreview(null);
    if (selected) void api.readVersion(path, selected).then(document => {
      if (cancelled) return;
      const png = canvasVersionPreview(document.data);
      if (png) {
        url = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' })); setPreview(url);
      }
    }).catch(error => { if (!cancelled) onError(error); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [api, path, selected, onError]);
  const version = history?.versions.find(item => item.id === selected);
  return <section ref={scroll} className={styles.history} aria-label="Canvas version history">
    <div className={styles.versions} aria-label="Canvas versions">
      {loading && <p role="status">Loading versions…</p>}
      {history?.versions.length === 0 && <p className={styles.description}>Save this canvas to start its history.</p>}
      {history?.versions.map(item => <NeumorphicButton key={item.id} variant="ghost" className={styles.version}
        aria-pressed={item.id === selected} onClick={() => setSelected(item.id)}>
        <span>{item.description}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
      </NeumorphicButton>)}
    </div>
    {version && <LiquidGlassPanel className={styles.preview} aria-label="Selected canvas version">
      <div className={styles.previewContent}>
        {preview ? <><span className={styles.description}>Embedded file preview</span><img src={preview} alt={`Embedded canvas preview: ${version.description}`} /></>
          : <p className={styles.description}>This version has no embedded preview.</p>}
        <p>{version.description}</p>
        {disabled && <p className={styles.description}>Save open canvas changes before restoring.</p>}
      </div>
      <NeumorphicButton variant="standard" disabled={disabled || loading} onClick={() => setConfirm(true)}><RotateCcw aria-hidden="true" />Restore version</NeumorphicButton>
    </LiquidGlassPanel>}
    {confirm && history && version && <Modal title="Restore canvas version" headerVariant="section" closeButtonVariant="ghost"
      closeDisabled={disabled} onClose={() => setConfirm(false)}>
      <p>Restore “{version.description}”? Your current file will be kept in history. The restored design becomes a new version.</p>
      <div className={styles.actions}>
        <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => setConfirm(false)}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" disabled={disabled} onClick={() => {
          void onRestore({ path, versionId: version.id, expectedRevision: history.currentRevision }).then(() => setConfirm(false)).catch(onError);
        }}>Restore</NeumorphicButton>
      </div>
    </Modal>}
  </section>;
}
