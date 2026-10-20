import { Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UsagePopoverApi, UsagePopoverState } from '../../../../shared/account-usage-popover';
import { accountUsageTotals } from '../../../../shared/codex-account-usage';
import { NeumorphicButton } from '../../shared/ui';
import { AccountUsageDetails } from './AccountUsageDetails';
import { applyWindowAppearance } from '../settings/windowAppearance';
import accountStyles from './AccountUsagePanel.module.css';
import styles from './UsageTrayPopover.module.css';

export function UsageTrayPopover({ api }: { api: UsagePopoverApi }) {
  const [state, setState] = useState<UsagePopoverState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    const receive = (next: UsagePopoverState) => {
      if (!disposed) setState(previous => !previous || next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = api.onChange(receive);
    void api.read().then(receive).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; unsubscribe(); };
  }, [api]);
  useLayoutEffect(() => {
    if (state) document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
    if (state?.appearance) applyWindowAppearance(state.appearance);
    else document.documentElement.removeAttribute('data-window-glass');
  }, [state?.dark, state?.appearance]);
  useEffect(() => {
    if (!panel.current) return;
    let disposed = false;
    let measurement = 0;
    let frame = 0;
    const element = panel.current;
    const measure = () => {
      const current = ++measurement;
      cancelAnimationFrame(frame);
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height < 1) return;
      void api.resize(height).then(() => {
        if (disposed || current !== measurement || (!state && !error)) return;
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (disposed || current !== measurement) return;
            void api.ready(state?.revision ?? null).catch(cause => { if (!disposed) setError(String(cause)); });
          });
        });
      }).catch(cause => {
        if (!disposed) setError(String(cause));
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); };
  }, [api, state, error]);
  const perform = (action: 'show' | 'quit') => {
    void api.action(action).catch(cause => setError(String(cause)));
  };
  const totals = accountUsageTotals(state?.snapshot ?? null);
  return <main className={`window-appearance-surface ${styles.surface}`} aria-label="Account and usage">
    <div ref={panel} className={styles.panel}>
      <header className={accountStyles.heading}><span className={accountStyles.headingLabel}>ACCOUNT &amp; USAGE</span></header>
      {state?.snapshot?.profiles.map(profile => <AccountUsageDetails key={profile.id} profile={profile}
        active={profile.id === state.snapshot?.activeId} actions={profile.id === state.snapshot?.activeId
          ? <span className={styles.active} title="Currently in use"><Check aria-hidden="true" />Active</span> : undefined} />)}
      {!state && !error && <p className={accountStyles.status}>Loading accounts…</p>}
      {error && <p className={accountStyles.status} role="alert">{error}</p>}
      {state && <p className={styles.summary}>
        {totals ? <>
          <span>{totals.remaining}% remaining</span>
          <span>{totals.capacity}% total capacity</span>
          <span>{totals.accountCount} accounts</span>
        </> : 'Usage unavailable'}
      </p>}
      <footer className={styles.actions}>
        <NeumorphicButton variant="standard" size="standard" onClick={() => perform('show')}>Show Cheshi</NeumorphicButton>
        <NeumorphicButton variant="standard" size="standard" onClick={() => perform('quit')}>Quit Cheshi</NeumorphicButton>
      </footer>
    </div>
  </main>;
}
