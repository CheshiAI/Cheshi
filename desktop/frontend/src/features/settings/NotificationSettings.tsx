import { useEffect, useRef, useState } from 'react';
import { Save, Send } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { DEFAULT_IMESSAGE_PREFERENCES, type IMessageApi, type IMessagePreferences, type IMessageSettings } from '../../../../shared/imessage-notifications';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SettingsView.module.css';
import { DiscordSettings } from './DiscordSettings';
import { MessageCommandSettings } from './MessageCommandSettings';
import { NotificationEventsSettings } from './NotificationEventsSettings';
import type { NotificationEventsApi } from '../../../../shared/notification-events';

export function NotificationSettings({ api = cheshiDesktop?.iMessage, eventsApi, contextId, onStarted }: {
  api?: IMessageApi; eventsApi?: NotificationEventsApi; contextId?: string; onStarted?(thread: string): void;
}) {
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
    if (!api || pending.current || !draft.enabled) return;
    pending.current = true; setOperation(action); setError(null);
    try {
      const value = action === 'save' ? await api.save(draft) : await api.test();
      if (mounted.current) { setState(value); if (action === 'save') { edited.current = false; setDraft(value); } }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not update notifications.'); }
    finally { pending.current = false; if (mounted.current) setOperation(null); }
  };
  const toggle = async () => {
    if (!api || !state?.available || pending.current) return;
    const enabled = !draft.enabled;
    if (enabled && !state.recipient) { change({ enabled }); return; }
    pending.current = true; setOperation('save'); setError(null);
    try {
      const value = await api.save({ enabled, recipient: state.recipient });
      if (mounted.current) {
        setState(value); setDraft(current => ({ ...current, enabled: value.enabled }));
        edited.current = draft.recipient !== value.recipient;
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not update notifications.'); }
    finally { pending.current = false; if (mounted.current) setOperation(null); }
  };
  const disabled = operation === 'save' || !state?.available || !draft.enabled;
  const actionsDisabled = operation !== null || !state?.available || !draft.enabled;
  const notice = operation === 'test' ? 'Sending test iMessage…' : operation === 'save' ? 'Saving…' : error ?? state?.lastStatus ?? '';
  return <section className={styles.detail} aria-labelledby="notifications-heading"><div className={styles.scroll}>
    <NotificationEventsSettings api={eventsApi} />
    <form className={`${styles.form} ${styles.notificationDelivery}`} onSubmit={event => { event.preventDefault(); void run('save'); }}>
      <div className={styles.titleRow}><h2 className={styles.sectionTitle}>iMessage</h2></div>
      <div className={styles.settingRow}>
        <span className={styles.settingLabel}>Enable iMessage notifications</span>
        <NeumorphicButton type="button" className={styles.toggle} role="switch" aria-label="Enable iMessage notifications"
          aria-checked={draft.enabled} disabled={operation !== null || !state?.available}
          onClick={() => { void toggle(); }}><span aria-hidden="true" /></NeumorphicButton>
      </div>
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
        Save the recipient, then send a test to check receipt on your device.
      </p>
      <p role={error && !operation ? 'alert' : 'status'} aria-atomic="true"
        className={`${styles.description} ${styles.operationStatus}`}>{notice}</p>
      <p className={styles.description}>Off by default. Enable notifications, enter a recipient, and save to finish setup.<br />
        With a saved recipient, the switch applies automatically to all workspaces and temporary chats on this Mac.<br />
        Uses the notification events selected above.
      </p>
      <p className={styles.description}>
        Messages include the workspace, conversation identifier and status. Conversation text is not included.</p>
      <p className={styles.description}>Keep this Mac awake and online. Confirm receipt on your device, especially with the same Apple account.<br />
        Replies in Messages do not approve actions in Cheshi.</p>
      {api?.commands && <MessageCommandSettings api={api.commands} disabled={disabled}
        available={state?.available === true && Boolean(state.recipient)} />}
    </form>
    <DiscordSettings contextId={contextId} onStarted={onStarted} />
  </div></section>;
}
