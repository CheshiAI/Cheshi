import { useEffect, useRef, useState } from 'react';
import type { IMessageCommandApi, IMessageCommandSettings } from '../../../../shared/imessage-commands';
import { LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function MessageCommandSettings({ api, available, disabled = false }: { api: IMessageCommandApi; available: boolean; disabled?: boolean }) {
  const [state, setState] = useState<IMessageCommandSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    const refresh = async () => {
      if (pending.current) return;
      const generation = revision.current;
      try {
        const value = await api.get();
        if (active && generation === revision.current) setState(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
      } catch { if (active && generation === revision.current) setError('Could not read message command settings.'); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; mounted.current = false; clearInterval(timer); };
  }, [api]);
  const configure = async (enabled: boolean, targetId: string | null) => {
    if (pending.current || disabled) return;
    revision.current++; pending.current = true; setBusy(true); setError(null);
    try {
      const value = await api.configure({ enabled, targetId });
      if (mounted.current) setState(value);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not configure message commands.');
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className={styles.form}>
    <div className={styles.titleRow}><h2 className={styles.sectionTitle}>iMessage commands</h2></div>
    <div className={styles.settingRow}>
      <span className={styles.settingLabel}>Receive instructions from iMessage</span>
      <NeumorphicButton type="button" className={styles.toggle} role="switch" aria-label="Receive instructions from iMessage"
        aria-checked={state?.enabled === true} disabled={disabled || busy || !state || (!state.enabled && (!available || !state.targetId))}
        onClick={() => void configure(!state?.enabled, state?.targetId ?? null)}><span aria-hidden="true" /></NeumorphicButton>
    </div>
    <label className={styles.settingLabel}>Target conversation</label>
    <LiquidGlassSelect ariaLabel="iMessage target conversation" triggerAppearance="standard" menuAppearance="toolbar"
      placeholder="Select an open conversation" value={state?.targetId ?? ''} disabled={disabled || busy || !state || state.targets.length === 0}
      options={state?.targets.map(target => ({ value: target.id, label: target.label })) ?? []}
      onChange={target => void configure(false, target)} />
    <p className={styles.description}>Save your iMessage recipient above, then select an open conversation and enable commands.<br />
      Send “Cheshi status”, “Cheshi stop”, or “Cheshi continue the test”. Instructions join the current task while it is running.<br />
      Commands use the conversation’s existing model and permissions. Approvals and questions still require an answer in the app.</p>
    <p className={styles.description}>Changes apply automatically. Commands turn off when Cheshi restarts or the selected conversation changes.<br />
      Requires Full Disk Access. Only new, direct, plain-text iMessages from the saved recipient are processed.</p>
    <p role={error ? 'alert' : 'status'} className={`${styles.description} ${styles.operationStatus}`} aria-atomic="true">
      {error ?? (busy ? 'Updating…' : state?.status ?? 'Loading…')}
    </p>
  </div>;
}
