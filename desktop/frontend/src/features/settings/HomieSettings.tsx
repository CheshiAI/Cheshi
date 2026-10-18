import { useEffect, useRef, useState } from 'react';
import { useHomiesEnabled } from './useHomiesEnabled';
import { homiesReady, type HomieSetupStatus } from '../../../../shared/homie-setup';
import type { SettingsApi } from '../../../../shared/settings';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function HomieSettings({ api }: { api?: SettingsApi }) {
  const enabled = useHomiesEnabled(api);
  const [toggling, setToggling] = useState(false);
  const toggleActive = useRef(false);
  const [status, setStatus] = useState<HomieSetupStatus | null>(null);
  const [pending, setPending] = useState<'check' | 'install' | 'start' | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false), active = useRef(false), revision = useRef(0);
  const minimumDisplay = useRef<{ timer: ReturnType<typeof setTimeout>; finish(): void } | null>(null);
  const busy = toggling || pending !== null || status?.busy === true;
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
    return () => {
      disposed = true; mounted.current = false; revision.current++; clearTimeout(timer);
      if (minimumDisplay.current) {
        clearTimeout(minimumDisplay.current.timer); minimumDisplay.current.finish(); minimumDisplay.current = null;
      }
    };
  }, [api]);
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const perform = async (action: 'check' | 'install' | 'start') => {
    if (!api || active.current || status?.busy) return;
    active.current = true; revision.current++; setPending(action); setPendingSince(Date.now()); setError(null);
    const minimum = action === 'check' ? new Promise<void>(finish => {
      minimumDisplay.current = { timer: setTimeout(finish, 1000), finish };
    }) : Promise.resolve();
    try {
      const result = await (action === 'install' ? api.installHomieTools() : action === 'start' ? api.startHomieEngine() : api.getHomieSetup());
      await minimum;
      if (mounted.current) { revision.current++; setStatus(result); }
    } catch {
      await minimum;
      if (mounted.current) { revision.current++; setError('Could not complete Homies setup. Check the status and retry.'); }
    } finally {
      minimumDisplay.current = null; active.current = false;
      if (mounted.current) { setPending(null); setPendingSince(null); }
    }
  };
  const toggle = async () => {
    if (!api || enabled === null || toggleActive.current || busy) return;
    toggleActive.current = true; setToggling(true); setError(null);
    try { await api.setHomiesEnabled(!enabled); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not change Homies usage. Retry.'); }
    finally { toggleActive.current = false; if (mounted.current) setToggling(false); }
  };
  const startedAt = status?.busy ? status.startedAt : pendingSince;
  const elapsed = startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  const missing = status && (!status.docker || !status.colima);
  return <section className={styles.detail} aria-labelledby="homies-heading"><div className={styles.scroll}><div className={styles.form}>
    <div className={styles.titleRow}><h2 id="homies-heading" className={styles.sectionTitle}>Homies</h2></div>
    <div className={styles.settingRow}><span className={styles.settingLabel}>Enable Homies</span>
      <NeumorphicButton className={styles.toggle} role="switch" aria-label="Enable Homies" aria-checked={enabled === true}
        disabled={!api || enabled === null || busy || (!enabled && !homiesReady(status))} onClick={() => { void toggle(); }}>
        <span aria-hidden="true" />
      </NeumorphicButton>
    </div>
    <p className={styles.description}>{enabled ? 'Homies is on.' : 'Homies is off. Install the required tools and connect Colima to enable it.'}
      {' '}Changes apply to all workspaces. Turning Homies off disables Worker and Docker. Saved Homies, conversations and files are kept.
      Finish active work and close worker terminals before turning it off. Colima stays running.</p>
    <p className={styles.description}>Prepare Docker CLI and Colima to run Homies on this Mac. This checks the default Colima profile.</p>
    {(['Homebrew', 'Docker CLI', 'Colima'] as const).map((label, index) => {
      const installed = status && [status.brew, status.docker, status.colima][index];
      return <div className={styles.settingRow} key={label}><span className={styles.settingLabel}>{label}</span>
        <span className={styles.description}>{!status ? 'Checking…' : installed ? 'Installed' : 'Not installed'}</span></div>;
    })}
    <div className={styles.settingRow}><span className={styles.settingLabel}>Colima Docker connection</span>
      <span className={styles.description}>{!status ? 'Checking…' : status.connected ? 'Connected' : 'Not connected'}</span></div>
    <div className={styles.settingRow}><span className={styles.settingLabel}>Homie security profile</span>
      <span className={styles.description}>{!status ? 'Checking…' : !status.connected ? 'Connect Colima first' : status.securityReady ? 'Ready' : 'Preparation required'}</span></div>
    <div className={`${styles.actions} ${styles.homieActions}`}>
      <NeumorphicButton variant="standard" disabled={!api || !status?.supported || !status.brew || !missing || busy}
        onClick={() => { void perform('install'); }}>Install missing tools</NeumorphicButton>
      <NeumorphicButton variant="standard" disabled={!api || !status?.supported || !status.docker || !status.colima || (status.connected && status.securityReady) || busy}
        onClick={() => { void perform('start'); }}>{status?.connected ? 'Prepare Homies' : 'Start Colima'}</NeumorphicButton>
      <NeumorphicButton variant="ghost" aria-label="Check status" disabled={!api || busy}
        onClick={() => { void perform('check'); }}>{pending === 'check' ? 'Checking…' : 'Check status'}</NeumorphicButton>
    </div>
    {status?.supported && !status.brew && <p className={styles.description}>Install Homebrew using the instructions at{' '}
      <a href="https://brew.sh" target="_blank" rel="noreferrer">brew.sh</a>, then check again. Complete any requested Apple Command Line Tools setup.</p>}
    <p role="status" className={styles.description}>{!api ? 'Available in the Cheshi desktop app.'
      : toggling ? 'Changing Homies usage…' : pending === 'check' ? 'Checking the Homies environment…' : status?.detail ?? 'Checking the Homies environment…'}</p>
    {(pending !== null || status?.busy) && <div className={styles.homieProgress}>
      <div className={styles.homieProgressTrack} role="progressbar" aria-label="Homies setup progress"><span /></div>
      <p className={styles.description}>{`${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`}</p></div>}
    {(error || status?.error) && <p role="alert" className={styles.description}>{error ?? status?.error}</p>}
    <p className={styles.description}>Homebrew installs missing tools and their dependencies. Installation may take several minutes.
      Starting or preparing Colima installs and verifies the shared Homie security profile. Select colima as your Homie engine.
      Project sharing and worker setup are checked when the Homie starts.</p>
  </div></div></section>;
}
