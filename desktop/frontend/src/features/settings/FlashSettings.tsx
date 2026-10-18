import { useEffect, useRef, useState } from 'react';
import type { FlashReadiness, SettingsApi } from '../../../../shared/settings';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function FlashSettings({ api }: { api?: SettingsApi }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<FlashReadiness | null>(null);
  const [installing, setInstalling] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(false);

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
      try {
        const value = await api?.getFlashReadiness();
        if (!disposed && value) setReadiness(value);
      } catch {
        if (!disposed) setReadiness({ ready: false, detail: 'Could not check the Flash installation. Retry the check.' });
      } finally { if (!disposed) timer = setTimeout(() => { void check(); }, 2000); }
    };
    void check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [api]);

  const toggle = async () => {
    if (!api || enabled === null || pending.current || (!enabled && (!readiness?.ready || readiness.installing))) return;
    pending.current = true; setBusy(true); setError(null);
    const current = revision.current;
    try {
      const saved = await api.setFlashEnabled(!enabled);
      if (mounted.current && revision.current === current) setEnabled(saved);
    } catch {
      if (mounted.current && revision.current === current) setError('Could not save Flash usage. Try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const install = async () => {
    if (!api || pending.current || enabled || readiness?.installing) return;
    pending.current = true; setInstalling(true); setError(null);
    try {
      const status = await api.installFlash();
      if (mounted.current) setReadiness(status);
    } catch {
      if (mounted.current) setError('Flash installation did not complete. Check the status below, then retry.');
    } finally {
      pending.current = false;
      if (mounted.current) setInstalling(false);
    }
  };
  const check = async () => {
    if (!api) return;
    setReadiness(null);
    try { const status = await api.getFlashReadiness(); if (mounted.current) setReadiness(status); }
    catch { if (mounted.current) setReadiness({ ready: false, detail: 'Could not check the Flash installation. Retry the check.' }); }
  };

  return <section className={styles.detail} aria-labelledby="flash-heading">
    <div className={styles.scroll}>
      <div className={styles.form}>
        <div className={styles.titleRow}><h2 id="flash-heading" className={styles.sectionTitle}>Flash</h2></div>
        <div className={styles.settingRow}>
          <span className={styles.settingLabel}>Enable Flash memory</span>
          <NeumorphicButton className={styles.toggle} role="switch" aria-label="Enable Flash memory"
            aria-checked={enabled === true} disabled={!api || enabled === null || busy || installing ||
              (!enabled && (readiness?.ready !== true || readiness.installing === true))} onClick={() => { void toggle(); }}>
            <span aria-hidden="true" />
          </NeumorphicButton>
        </div>
        <p className={styles.description}>Search saved conversations with Flash. Requires a local Flash installation and offline model.</p>
        <div className={styles.actions}>
          <NeumorphicButton variant="standard" disabled={!api || enabled !== false || busy || installing || readiness?.installing === true}
            onClick={() => { void install(); }}>{installing || readiness?.installing ? 'Installing Flash…' : 'Install Flash'}</NeumorphicButton>
          <NeumorphicButton variant="ghost" disabled={!api || busy || installing || readiness?.installing === true}
            onClick={() => { void check(); }}>Check installation</NeumorphicButton>
        </div>
        <p className={styles.description}>Installs the Flash service, Python dependencies and EmbeddingGemma 2. Internet access and GitHub access to CheshiAI/Cheshi-flash are required. Downloads may take several minutes. Installed files are kept across app updates.</p>
        <p role="status" className={styles.description}>{readiness?.detail ?? 'Checking Flash installation…'}</p>
        <p className={styles.description}>Off by default. Changes apply to all open workspaces and Homies on this device.<br />
          Turning Flash off stops memory searches and synchronization. Saved conversations and model files are kept.<br />
          Chat and conversation list search remain available.</p>
        {error ? <p role="alert" className={styles.description}>{error}</p>
          : <p role="status" className={styles.description}>{busy ? 'Checking Flash and loading the model…' : !api ? 'Available in the Cheshi desktop app.'
            : enabled === null ? 'Loading settings…' : enabled ? 'Flash is on.' : 'Flash is off.'}</p>}
      </div>
    </div>
  </section>;
}
