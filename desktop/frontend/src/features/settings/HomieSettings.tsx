import { useEffect, useRef, useState } from 'react';
import type { HomieSetupStatus } from '../../../../shared/homie-setup';
import type { SettingsApi } from '../../../../shared/settings';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function HomieSettings({ api }: { api?: SettingsApi }) {
  const [status, setStatus] = useState<HomieSetupStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false), active = useRef(false), revision = useRef(0);
  const busy = pending || status?.busy === true;
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const current = revision.current;
      try {
        const value = await api?.getHomieSetup();
        if (!disposed && current === revision.current && value) setStatus(value);
      } catch {
        if (!disposed && current === revision.current) setError('Could not check the Homies environment. Retry the check.');
      } finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 2000); }
    };
    setStatus(null); setError(null); void poll();
    return () => { disposed = true; mounted.current = false; revision.current++; clearTimeout(timer); };
  }, [api]);
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const perform = async (action: 'check' | 'install' | 'start') => {
    if (!api || active.current || status?.busy) return;
    active.current = true; revision.current++; setPending(true); setError(null);
    try {
      const result = await (action === 'install' ? api.installHomieTools() : action === 'start' ? api.startHomieEngine() : api.getHomieSetup());
      if (mounted.current) { revision.current++; setStatus(result); }
    } catch {
      if (mounted.current) { revision.current++; setError('Could not complete Homies setup. Check the status and retry.'); }
    } finally { active.current = false; if (mounted.current) setPending(false); }
  };
  const elapsed = status?.startedAt === undefined ? 0 : Math.max(0, Math.floor((now - status.startedAt) / 1000));
  const missing = status && (!status.docker || !status.colima);
  return <section className={styles.detail} aria-labelledby="homies-heading"><div className={styles.scroll}><div className={styles.form}>
    <div className={styles.titleRow}><h2 id="homies-heading" className={styles.sectionTitle}>Homies</h2></div>
    <p className={styles.description}>Prepare Docker CLI and Colima to run Homies on this Mac. This checks the default Colima profile.</p>
    {(['Homebrew', 'Docker CLI', 'Colima'] as const).map((label, index) => {
      const installed = status && [status.brew, status.docker, status.colima][index];
      return <div className={styles.settingRow} key={label}><span className={styles.settingLabel}>{label}</span>
        <span className={styles.description}>{!status ? 'Checking…' : installed ? 'Installed' : 'Not installed'}</span></div>;
    })}
    <div className={styles.settingRow}><span className={styles.settingLabel}>Colima Docker connection</span>
      <span className={styles.description}>{!status ? 'Checking…' : status.connected ? 'Connected' : 'Not connected'}</span></div>
    <div className={`${styles.actions} ${styles.homieActions}`}>
      <NeumorphicButton variant="standard" disabled={!api || !status?.supported || !status.brew || !missing || busy}
        onClick={() => { void perform('install'); }}>Install missing tools</NeumorphicButton>
      <NeumorphicButton variant="standard" disabled={!api || !status?.supported || !status.docker || !status.colima || status.connected || busy}
        onClick={() => { void perform('start'); }}>Start Colima</NeumorphicButton>
      <NeumorphicButton variant="ghost" disabled={!api || busy} onClick={() => { void perform('check'); }}>Check status</NeumorphicButton>
    </div>
    {status?.supported && !status.brew && <p className={styles.description}>Install Homebrew using the instructions at{' '}
      <a href="https://brew.sh" target="_blank" rel="noreferrer">brew.sh</a>, then check again. Complete any requested Apple Command Line Tools setup.</p>}
    <p role="status" className={styles.description}>{!api ? 'Available in the Cheshi desktop app.' : status?.detail ?? 'Checking the Homies environment…'}</p>
    {busy && <div className={styles.homieProgress}><progress aria-label="Homies setup progress" />
      <p className={styles.description}>{`${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`}</p></div>}
    {(error || status?.error) && <p role="alert" className={styles.description}>{error ?? status?.error}</p>}
    <p className={styles.description}>Homebrew installs missing tools and their dependencies. Installation may take several minutes.
      After starting Colima, select colima as your Homie engine. Project sharing and worker setup are checked when the Homie starts.</p>
  </div></div></section>;
}
