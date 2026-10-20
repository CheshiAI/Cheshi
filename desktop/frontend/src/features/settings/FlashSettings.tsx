import { useEffect, useRef, useState } from 'react';
import type { FlashReadiness, SettingsApi } from '../../../../shared/settings';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function FlashSettings({ api }: { api?: SettingsApi }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<FlashReadiness | null>(null);
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [operationStartedAt, setOperationStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const pending = useRef(false);
  const revision = useRef(0);
  const readinessRevision = useRef(0);
  const mounted = useRef(false);
  const installationActive = installing || removing || readiness?.installing === true;
  const startedAt = readiness?.installing === true ? readiness.progress?.startedAt ?? operationStartedAt : operationStartedAt;
  const elapsed = startedAt === null || startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  const duration = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`;
  const bytes = readiness?.installing === true ? readiness.progress : undefined;
  const percent = bytes?.totalBytes && bytes.downloadedBytes !== undefined
    ? Math.floor(bytes.downloadedBytes / bytes.totalBytes * 100) : undefined;

  useEffect(() => {
    if (!installationActive && !busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [installationActive, busy]);

  useEffect(() => {
    mounted.current = true;
    const current = ++revision.current;
    setEnabled(null); setError(null);
    const unsubscribe = api?.onFlashEnabledChanged(value => {
      revision.current++;
      setEnabled(value); setError(null);
    });
    void api?.getFlashEnabled().then(value => {
      if (mounted.current && revision.current === current) setEnabled(value);
    }).catch(() => {
      if (mounted.current && revision.current === current) setError('Could not load Flash usage.');
    });
    return () => { mounted.current = false; revision.current++; unsubscribe?.(); };
  }, [api]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReadiness(null);
    const check = async () => {
      const current = readinessRevision.current;
      try {
        const value = await api?.getFlashReadiness();
        if (!disposed && current === readinessRevision.current && value) setReadiness(value);
      } catch {
        if (!disposed && current === readinessRevision.current) setReadiness({ ready: false, detail: 'Could not check the Flash installation. Retry the check.' });
      } finally { if (!disposed) timer = setTimeout(() => { void check(); }, 2000); }
    };
    void check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [api]);

  const toggle = async () => {
    if (!api || enabled === null || pending.current || (!enabled && (!readiness?.ready || readiness.installing))) return;
    pending.current = true; setBusy(true); setError(null); setOperationStartedAt(Date.now());
    const current = revision.current;
    try {
      const saved = await api.setFlashEnabled(!enabled);
      if (mounted.current && revision.current === current) setEnabled(saved);
    } catch {
      if (mounted.current && revision.current === current) setError('Could not save Flash usage. Try again.');
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); setOperationStartedAt(null); }
    }
  };

  const install = async () => {
    if (!api || pending.current || enabled || readiness?.installing) return;
    pending.current = true; setInstalling(true); setError(null); setUpdateNote(null); setOperationStartedAt(Date.now());
    readinessRevision.current++;
    setReadiness({ ready: false, installing: true, detail: 'Preparing Flash…' });
    try {
      const status = await api.installFlash(source.trim() || undefined);
      if (mounted.current) { readinessRevision.current++; setReadiness(status); }
    } catch (cause) {
      if (mounted.current) {
        readinessRevision.current++;
        setError(cause instanceof Error ? cause.message : 'Flash installation did not complete. Check the status below, then retry.');
        setReadiness(null);
      }
    } finally {
      pending.current = false;
      if (mounted.current) { setInstalling(false); setOperationStartedAt(null); }
    }
  };
  const checkUpdates = async () => {
    if (!api || pending.current) return;
    pending.current = true; setCheckingUpdates(true); setError(null); setUpdateNote(null);
    try {
      const status = await api.checkFlashUpdates(source.trim() || undefined);
      if (mounted.current) {
        readinessRevision.current++; setReadiness(status);
        setUpdateNote(status.availableVersion ? `Flash ${status.availableVersion} is available.` : 'The installed Flash plugin is up to date.');
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not check Flash updates. The release may not be published or accessible yet.');
    } finally { pending.current = false; if (mounted.current) setCheckingUpdates(false); }
  };
  const uninstall = async () => {
    if (!api || pending.current || enabled || !readiness?.installedVersion) return;
    pending.current = true; setRemoving(true); setError(null); setUpdateNote(null); setOperationStartedAt(Date.now());
    readinessRevision.current++;
    try {
      const status = await api.uninstallFlash();
      if (mounted.current) { readinessRevision.current++; setReadiness(status); }
    } catch { if (mounted.current) setError('Could not remove Flash. Turn it off and retry.'); }
    finally { pending.current = false; if (mounted.current) { setRemoving(false); setOperationStartedAt(null); } }
  };
  const check = async () => {
    if (!api) return;
    const current = ++readinessRevision.current;
    setReadiness(null);
    try { const status = await api.getFlashReadiness(); if (mounted.current && current === readinessRevision.current) setReadiness(status); }
    catch { if (mounted.current && current === readinessRevision.current) setReadiness({ ready: false, detail: 'Could not check the Flash installation. Retry the check.' }); }
  };

  return <section className={styles.detail} aria-labelledby="flash-heading">
    <div className={styles.scroll}>
      <div className={styles.form}>
        <div className={styles.titleRow}><h2 id="flash-heading" className={styles.sectionTitle}>Flash</h2></div>
        <div className={styles.settingRow}>
          <span className={styles.settingLabel}>Enable Flash memory</span>
          <NeumorphicButton className={styles.toggle} role="switch" aria-label="Enable Flash memory"
            aria-checked={enabled === true} disabled={!api || enabled === null || busy || installationActive || checkingUpdates ||
              (!enabled && (readiness?.ready !== true || readiness.installing === true))} onClick={() => { void toggle(); }}>
            <span aria-hidden="true" />
          </NeumorphicButton>
        </div>
        <p className={styles.description}>Search saved conversations with Flash. Requires a local Flash installation and offline model.</p>
        <label className={styles.form}>
          <span className={styles.settingLabel}>Test installation source</span>
          <NeumorphicTextField variant="standard" aria-label="Test installation source"
            placeholder="Flash project folder, release JSON path, or HTTPS URL"
            value={source} disabled={!api || busy || installationActive || checkingUpdates}
            onChange={event => { setSource(event.target.value); setError(null); setUpdateNote(null); }}
            onClear={() => { setSource(''); setError(null); setUpdateNote(null); }} clearLabel="Clear Flash installation source" />
        </label>
        <p className={styles.description}>Use a local Flash project or package folder, a release JSON file, or an HTTPS release URL.
          Leave empty to use the default release. This test value is not saved.</p>
        <div className={`${styles.actions} ${styles.flashActions}`}>
          <NeumorphicButton variant="standard" disabled={!api || enabled !== false || busy || installationActive || checkingUpdates}
            onClick={() => { void install(); }}>{installationActive ? (removing ? 'Removing Flash…' : 'Installing Flash…')
              : readiness?.installedVersion ? (readiness.availableVersion ? 'Update Flash' : 'Reinstall Flash') : 'Install Flash'}</NeumorphicButton>
          <NeumorphicButton variant="ghost" disabled={!api || busy || installationActive || checkingUpdates}
            onClick={() => { void check(); }}>Check installation</NeumorphicButton>
          <NeumorphicButton variant="ghost" disabled={!api || busy || installationActive || checkingUpdates}
            onClick={() => { void checkUpdates(); }}>{checkingUpdates ? 'Checking updates…' : 'Check updates'}</NeumorphicButton>
          {readiness?.installedVersion && <NeumorphicButton variant="ghost" disabled={!api || enabled !== false || busy || installationActive || checkingUpdates}
            onClick={() => { void uninstall(); }}>Remove Flash</NeumorphicButton>}
        </div>
        <p className={styles.description}>{readiness?.installedVersion ? `Installed Flash plugin: ${readiness.installedVersion}. ` : ''}
          Installs the Flash plugin and EmbeddingGemma 2. Downloads may take several minutes. Updates reuse existing model files.
          Turn Flash off before updating or removing it. Removing the plugin keeps saved conversations and model files.</p>
        {updateNote && <p role="status" className={styles.description}>{updateNote}</p>}
        <p role="status" className={styles.description}>{readiness?.detail ?? 'Checking Flash installation…'}</p>
        {installationActive && <div className={styles.flashProgress}>
          <progress className={styles.flashProgressBar} aria-label="Flash installation progress" max={100} value={percent} />
          <p className={styles.description}>{percent === undefined ? (removing ? 'Removal in progress' : 'Installation in progress')
            : `${bytes?.phase === 'package' ? 'Plugin download' : 'Model download'} ${percent}%`}
            {bytes?.totalBytes !== undefined && bytes.downloadedBytes !== undefined
              ? ` · ${(bytes.downloadedBytes / 1048576).toFixed(1)} / ${(bytes.totalBytes / 1048576).toFixed(1)} MiB${bytes.phase === 'package' ? '' : ' (including reused files)'}` : ''}
            {` · ${duration}`}</p>
        </div>}
        <p className={styles.description}>Off by default. Changes apply to all open workspaces and Homies on this device.<br />
          Turning Flash off stops memory searches and synchronization. Saved conversations and model files are kept.<br />
          Chat and conversation list search remain available.</p>
        {error ? <p role="alert" className={styles.description}>{error}</p>
          : <p role="status" className={styles.description}>{busy ? `Checking Flash and loading the model… · ${duration}` : !api ? 'Available in the Cheshi desktop app.'
            : enabled === null ? 'Loading settings…' : enabled ? 'Flash is on.' : 'Flash is off.'}</p>}
      </div>
    </div>
  </section>;
}
