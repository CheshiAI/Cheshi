import { useEffect, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { NotificationEventsApi, NotificationEventSettings, NotificationKind } from '../../../../shared/notification-events';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function NotificationEventsSettings({ api = cheshiDesktop?.notificationEvents }: { api?: NotificationEventsApi }) {
  const [state, setState] = useState<NotificationEventSettings | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef(false), mounted = useRef(false), received = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const version = received.current;
    const unsubscribe = api?.onChanged(value => { received.current++; if (active) setState(value); });
    void api?.get().then(value => { if (active && version === received.current) setState(value); })
      .catch(() => { if (active) setError('Could not load notification events.'); });
    return () => { active = false; mounted.current = false; unsubscribe?.(); };
  }, [api]);
  const change = async (kind: NotificationKind) => {
    if (!api || !state || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    const version = received.current;
    try {
      const next = await api.set(kind, !state[kind]);
      if (mounted.current && version === received.current) setState(next);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save notification events.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className={styles.form}>
    <div className={styles.titleRow}><h2 id="notifications-heading" className={styles.sectionTitle}>Notification events</h2></div>
    <p className={styles.description}>Choose which events send notifications through iMessage and Discord on this Mac.</p>
    {([['completed', 'Work completed'], ['attention', 'Approval or answer needed'], ['failed', 'Work failed']] as const).map(([kind, label]) =>
      <div className={styles.settingRow} key={kind}><span className={styles.settingLabel}>{label}</span>
        <NeumorphicButton type="button" className={styles.toggle} role="switch" aria-label={label}
          aria-checked={state?.[kind] === true} disabled={!api || !state || busy || Boolean(state.error)}
          onClick={() => { void change(kind); }}><span aria-hidden="true" /></NeumorphicButton></div>)}
    <p className={styles.description}>Changes apply automatically to all workspaces on this Mac.<br />
      Completion waits for the conversation’s queue to empty. Cancelled work does not send failure alerts.</p>
    {(error || state?.error) && <p className={styles.description} role="alert">{error || state?.error}</p>}
  </div>;
}
