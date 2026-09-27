import { useEffect, useRef, useState } from 'react';
import { Save, Send } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { DEFAULT_IMESSAGE_PREFERENCES, type IMessageApi, type IMessagePreferences, type IMessageSettings } from '../../../../shared/imessage-notifications';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SettingsView.module.css';
import { DiscordSettings } from './DiscordSettings';
import { MessageCommandSettings } from './MessageCommandSettings';

export function NotificationSettings({ api = cheshiDesktop?.iMessage, contextId, onStarted }: { api?: IMessageApi; contextId?: string; onStarted?(thread: string): void }) {
  const [state, setState] = useState<IMessageSettings | null>(null);
  const [draft, setDraft] = useState<IMessagePreferences>({ ...DEFAULT_IMESSAGE_PREFERENCES });
  const [operation, setOperation] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true, changed = false;
    const receive = (value: IMessageSettings) => {
      if (!active) return;
      setState(value); if (!edited.current) setDraft(value);
    };
    const unsubscribe = api?.onChanged(value => { changed = true; receive(value); });
    void api?.get().then(value => { if (!changed) receive(value); }).catch(() => { if (active) setError('Could not load notification settings.'); });
    return () => { active = false; mounted.current = false; unsubscribe?.(); };
  }, [api]);
  const change = (patch: Partial<IMessagePreferences>) => { edited.current = true; setDraft(current => ({ ...current, ...patch })); };
  const run = async (action: 'save' | 'test') => {
    if (!api || pending.current) return;
    pending.current = true; setOperation(action); setError(null);
    try {
      const value = action === 'save' ? await api.save(draft) : await api.test();
      if (mounted.current) { setState(value); if (action === 'save') { edited.current = false; setDraft(value); } }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not update notifications.'); }
    finally { pending.current = false; if (mounted.current) setOperation(null); }
  };
  const disabled = operation === 'save' || !state?.available;
  const actionsDisabled = operation !== null || !state?.available;
  const notice = operation === 'test' ? 'Sending test iMessage…' : operation === 'save' ? 'Saving…' : error ?? state?.lastStatus ?? '';
  const switches = [['enabled', 'Enable iMessage notifications'], ['completed', 'Work completed'],
    ['attention', 'Approval or answer needed'], ['failed', 'Work failed']] as const;
  return <section className={styles.detail} aria-labelledby="notifications-heading"><div className={styles.scroll}>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void run('save'); }}>
      <div className={styles.titleRow}><h2 id="notifications-heading" className={styles.sectionTitle}>iMessage notifications</h2></div>
      <p className={styles.description}>Receive work updates at your iMessage phone number or email address.</p>
      {!api && <p className={styles.description}>Available in the Cheshi macOS app.</p>}
      {api && !state && !error && <p role="status" className={styles.description}>Loading settings…</p>}
      {state && !state.available && <p className={styles.description}>iMessage notifications require macOS.</p>}
      <div className={styles.keyRow}>
        <NeumorphicTextField id="imessage-recipient" aria-label="Recipient" aria-describedby="imessage-recipient-help"
          variant="standard" value={draft.recipient} disabled={disabled}
          placeholder="+821012345678 or name@example.com" autoComplete="off" spellCheck={false} maxLength={254}
          onChange={event => change({ recipient: event.target.value })} />
        <div className={styles.actions}>
          <NeumorphicButton className={styles.circleButton} raised size="icon" type="submit" disabled={actionsDisabled}
            aria-label="Save notification settings" title="Save notification settings"><Save aria-hidden="true" /></NeumorphicButton>
          <NeumorphicButton className={styles.circleButton} raised size="icon" type="button"
            disabled={actionsDisabled || edited.current || !state?.recipient} aria-label="Send test iMessage" title="Send test iMessage"
            onClick={() => void run('test')}><Send aria-hidden="true" /></NeumorphicButton>
        </div>
      </div>
      <p id="imessage-recipient-help" className={styles.description}>
        Use a number or email enabled for iMessage. Sign in to Messages on this Mac and allow automation when prompted.<br />
        Save changes, then send a test to check receipt on your device. Testing sends one message even when notifications are off.
      </p>
      <p role={error && !operation ? 'alert' : 'status'} aria-atomic="true"
        className={`${styles.description} ${styles.operationStatus}`}>{notice}</p>
      {switches.map(([key, label]) => <div className={styles.settingRow} key={key}>
        <span className={styles.settingLabel}>{label}</span>
        <NeumorphicButton type="button" className={styles.toggle} role="switch" aria-label={label}
          aria-checked={draft[key]} disabled={disabled} onClick={() => change({ [key]: !draft[key] })}><span aria-hidden="true" /></NeumorphicButton>
      </div>)}
      <p className={styles.description}>Off by default. Save to apply your choices to all workspaces and temporary chats.<br />
        Completion waits for the conversation’s queue to empty. Cancelled work does not send failure alerts.<br />
        Messages include the workspace, conversation identifier and status. Conversation text is not included.</p>
      <p className={styles.description}>Keep this Mac awake and online. Confirm receipt on your device, especially with the same Apple account.<br />
        Replies in Messages do not approve actions in Cheshi.</p>
      {api?.commands && <MessageCommandSettings api={api.commands} available={state?.available === true && Boolean(state.recipient)} />}
    </form>
    <DiscordSettings contextId={contextId} onStarted={onStarted} />
  </div></section>;
}
