import { useEffect, useRef, useState } from 'react';
import { Save, Send } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { DiscordApi, DiscordPreferences, DiscordSettings as Snapshot } from '../../../../shared/discord';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function DiscordSettings({ api = cheshiDesktop?.discord, contextId, onStarted }: {
  api?: DiscordApi; contextId?: string; onStarted?(thread: string): void;
}) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<DiscordPreferences>({ enabled: false, guildId: '', ownerId: '', deviceName: '' });
  const [token, setToken] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), edited = useRef(false), mounted = useRef(false), revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let active = true, reading = false;
    const read = async () => {
      if (!api || pending.current || reading) return;
      reading = true; const version = revision.current;
      try {
        const next = await api.get();
        if (active && version === revision.current) {
          setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
          if (!edited.current) setDraft(next);
        }
      } catch { if (active) setNotice('Could not load Discord settings.'); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 3000);
    return () => { active = false; mounted.current = false; clearInterval(timer); };
  }, [api]);
  const change = (patch: Partial<DiscordPreferences>) => { edited.current = true; setDraft(previous => ({ ...previous, ...patch })); };
  const run = async (action: 'save' | 'test' | 'setup') => {
    if (!api || pending.current) return;
    pending.current = true; revision.current++; setBusy(true); setNotice('');
    try {
      if (action === 'setup') { const thread = await api.setup(contextId); if (mounted.current) onStarted?.(thread); }
      else {
        const result = action === 'save' ? await api.save({ ...draft, ...(token ? { token } : {}) }) : await api.test();
        if (mounted.current) {
          setState(result);
          if (action === 'save') { setToken(''); edited.current = false; setDraft(result); }
          else setNotice('Test queued. Confirm receipt on your phone.');
        }
      }
    } catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : 'Discord operation failed.'); }
    finally { pending.current = false; revision.current++; if (mounted.current) setBusy(false); }
  };
  return <form className={`${styles.form} ${styles.discordForm}`} onSubmit={event => { event.preventDefault(); void run('save'); }}>
    <div className={styles.titleRow}><h2 className={styles.sectionTitle}>Discord</h2>
      <NeumorphicButton type="button" className={styles.discordSetup} disabled={busy || !api || !onStarted} onClick={() => void run('setup')}>Setup assistant</NeumorphicButton></div>
    <p className={styles.description}>Use your personal bot and private server. Each new chat session gets its own channel under this Mac.</p>
    <label className={styles.settingLabel}>Bot token
      <NeumorphicTextField variant="standard" type="password" value={token} disabled={busy || !api} maxLength={512}
        placeholder={state?.hasToken ? 'Saved securely · enter a replacement token' : 'Enter your personal bot token'} autoComplete="off"
        onChange={event => { edited.current = true; setToken(event.target.value); }} /></label>
    {([['guildId', 'Server ID'], ['ownerId', 'Your user ID'], ['deviceName', 'Device name']] as const).map(([key, label]) =>
      <label className={styles.settingLabel} key={key}>{label}<NeumorphicTextField variant="standard" value={draft[key]}
        disabled={busy || !api} maxLength={key === 'deviceName' ? 60 : 20} onChange={event => change({ [key]: event.target.value })} /></label>)}
    <div className={styles.settingRow}><span className={styles.settingLabel}>Enable Discord connection</span>
      <NeumorphicButton type="button" className={styles.toggle} role="switch" aria-label="Enable Discord connection"
        aria-checked={draft.enabled} disabled={busy || !api} onClick={() => change({ enabled: !draft.enabled })}><span aria-hidden="true" /></NeumorphicButton></div>
    <div className={styles.actions}>
      <NeumorphicButton className={styles.circleButton} raised size="icon" type="submit" disabled={busy || !api}
        aria-label="Save Discord settings" title="Save Discord settings"><Save aria-hidden="true" /></NeumorphicButton>
      <NeumorphicButton className={styles.circleButton} raised size="icon" type="button" disabled={busy || !state?.connected || edited.current}
        aria-label="Send test Discord notification" title="Send test Discord notification" onClick={() => void run('test')}><Send aria-hidden="true" /></NeumorphicButton>
    </div>
    <p role="status" className={`${styles.description} ${styles.operationStatus}`}>{busy ? 'Working…' : notice || state?.status || 'Loading…'}</p>
    <p className={styles.description}>{state?.channels ?? 0} session channels · {state?.pending ?? 0} pending deliveries</p>
    <p className={styles.description}>Only the registered server owner can issue instructions. Keep the server limited to you and your bot.
      Enable Message Content Intent in the Discord Developer Portal. Enter secrets only in the token field.</p>
    <p className={styles.description}>Keep this Mac awake with Cheshi running. Discord on this Mac can be closed.
      Approval and question responses are handled in Cheshi. Phone notifications depend on Discord and your device settings.</p>
  </form>;
}
