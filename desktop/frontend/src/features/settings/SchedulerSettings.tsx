import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SCHEDULER_NOTIFICATION_POSITION, type SchedulerApi } from '../../../../shared/scheduler';
import { LiquidGlassSelect } from '../../shared/ui/LiquidGlassSelect';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { useScheduler } from '../scheduler/useScheduler';
import styles from './SettingsView.module.css';

export function SchedulerSettings({ api: providedApi }: { api?: SchedulerApi }) {
  const { api, state, refresh } = useScheduler(providedApi);
  const [loaded, setLoaded] = useState(false);
  const [startup, setStartup] = useState({ enabled: false, available: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setLoaded(false);
    setStartup({ enabled: false, available: false });
    if (api) {
      void refresh().then(() => { if (active) setLoaded(true); });
      void api.startup?.().then(value => { if (active) setStartup(value); })
        .catch(cause => { if (active) setError(String(cause)); });
    }
    return () => { active = false; mounted.current = false; };
  }, [api, refresh]);
  const perform = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await operation(); await refresh(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className={styles.detail} aria-labelledby="scheduler-heading"><div className={styles.scroll}>
    <div className={styles.form}>
      <div className={styles.titleRow}><h2 id="scheduler-heading" className={styles.sectionTitle}>Scheduler</h2></div>
      <div className={styles.settingRow}>
        <span className={styles.settingLabel}>Auto</span>
        <ToggleSwitch aria-label="Automatically run scheduled tasks" aria-describedby="scheduler-auto-description"
          checked={state.auto} disabled={!api || !loaded || busy}
          onChange={enabled => { if (api) void perform(() => api.setAuto(enabled)); }} />
      </div>
      <p id="scheduler-auto-description" className={styles.description}>Run scheduled tasks automatically at their scheduled time. When off, each run needs your approval. Applies to all workspaces.</p>
      <div className={styles.settingRow}>
        <span className={styles.settingLabel}>Launch at login</span>
        <ToggleSwitch aria-label="Launch Cheshi at login" aria-describedby="scheduler-startup-description"
          checked={startup.enabled} disabled={!startup.available || !api?.setStartup || busy}
          onChange={enabled => { if (api?.setStartup && api.startup) void perform(async () => {
            await api.setStartup!(enabled);
            const value = await api.startup!();
            if (mounted.current) setStartup(value);
          }); }} />
      </div>
      <p id="scheduler-startup-description" className={styles.description}>Start Cheshi when you sign in to keep scheduled tasks available in the background. Available in the installed macOS app.</p>
      <div className={styles.settingRow}>
        <span className={styles.settingLabel}>Notification position</span>
        <LiquidGlassSelect ariaLabel="Scheduler notification position" triggerAppearance="standard" menuAppearance="toolbar"
          value={state.notificationPosition ?? DEFAULT_SCHEDULER_NOTIFICATION_POSITION}
          disabled={!api?.setNotificationPosition || !loaded || busy}
          options={[{ value: 'bottom-left', label: 'Bottom left' }, { value: 'top-right', label: 'Top right' }, { value: 'bottom-right', label: 'Bottom right' }]}
          onChange={position => { if (api?.setNotificationPosition) void perform(() => api.setNotificationPosition!(position)); }} />
      </div>
      <p className={styles.description}>Position of in-app schedule notifications. Saved on this Mac and shared across workspaces and accounts.</p>
      {!api && <p role="status" className={styles.description}>Scheduler settings are available in the Cheshi desktop app.</p>}
      {api && !loaded && <p role="status" className={styles.description}>Loading scheduler settings…</p>}
      {busy && <p role="status" className={styles.description}>Saving…</p>}
      {(error || state.error) && <p role="alert" className={styles.description}>{error || state.error}</p>}
    </div>
  </div></section>;
}
