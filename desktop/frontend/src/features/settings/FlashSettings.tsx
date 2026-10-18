import { useEffect, useRef, useState } from 'react';
import type { SettingsApi } from '../../../../shared/settings';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function FlashSettings({ api }: { api?: SettingsApi }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const toggle = async () => {
    if (!api || enabled === null || pending.current) return;
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

  return <section className={styles.detail} aria-labelledby="flash-heading">
    <div className={styles.scroll}>
      <div className={styles.form}>
        <div className={styles.titleRow}><h2 id="flash-heading" className={styles.sectionTitle}>Flash</h2></div>
        <div className={styles.settingRow}>
          <span className={styles.settingLabel}>Enable Flash memory</span>
          <NeumorphicButton className={styles.toggle} role="switch" aria-label="Enable Flash memory"
            aria-checked={enabled === true} disabled={!api || enabled === null || busy} onClick={() => { void toggle(); }}>
            <span aria-hidden="true" />
          </NeumorphicButton>
        </div>
        <p className={styles.description}>Search saved conversations with Flash. Requires a local Flash installation and offline model.</p>
        <p className={styles.description}>Off by default. Changes apply to all open workspaces and Homies on this device.<br />
          Turning Flash off stops memory searches and synchronization. Saved conversations and model files are kept.<br />
          Chat and conversation list search remain available.</p>
        {error ? <p role="alert" className={styles.description}>{error}</p>
          : <p role="status" className={styles.description}>{busy ? 'Saving…' : !api ? 'Available in the Cheshi desktop app.'
            : enabled === null ? 'Loading settings…' : enabled ? 'Flash is on.' : 'Flash is off.'}</p>}
      </div>
    </div>
  </section>;
}
