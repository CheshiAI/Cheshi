import { useEffect, useState, useSyncExternalStore } from 'react';
import { Send } from 'lucide-react';
import { MAIL_BODY_LIMIT } from '../../../../shared/apple-mail';
import { Modal, NeumorphicButton, NeumorphicSurface, NeumorphicTextField } from '../../shared/ui';
import type { MailComposer } from './mailComposer';
import styles from './Mail.module.css';

export function MailComposerDialog({ composer }: { composer: MailComposer }) {
  const state = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    const preventClose = (event: BeforeUnloadEvent) => {
      if (state.form || state.busy) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', preventClose);
    return () => window.removeEventListener('beforeunload', preventClose);
  }, [state.form, state.busy]);
  useEffect(() => { if (!state.visible) setDiscard(false); }, [state.visible]);
  if (!state.visible) return null;
  const form = state.form;
  const disabled = state.busy || state.blocked;
  const review = state.confirmation;
  return <Modal title={state.reply ? (state.reply.all ? 'Reply all' : 'Reply') : 'New message'} titleIcon={<Send aria-hidden="true" />}
    onClose={() => composer.hide()} closeDisabled={state.busy || state.loading}>
    <div className={styles.form}>
      {state.loading && <p role="status">Checking sending accounts…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {form && <>
        {review ? <section className={styles.review} aria-label="Review before sending">
          <h3>Send this message?</h3>
          <dl><dt>From</dt><dd>{review.sender}</dd><dt>To</dt><dd>{review.to.join(', ') || 'None'}</dd>
            <dt>Cc</dt><dd>{review.cc.join(', ') || 'None'}</dd><dt>Bcc</dt><dd>{review.bcc.join(', ') || 'None'}</dd>
            <dt>Subject</dt><dd>{review.subject || '(No subject)'}</dd></dl>
          <pre className={styles.bodyText}>{review.body || '(No content)'}</pre>
          <div className={styles.toolbar}>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => composer.back()}>Continue editing</NeumorphicButton>
            <NeumorphicButton raised size="standard" disabled={state.busy} onClick={() => void composer.send()}>
              {state.busy ? 'Sending…' : 'Confirm and send'}</NeumorphicButton>
          </div>
        </section> : <>
          <label className={styles.field}>From<NeumorphicSurface raised highlightFocus className={styles.selectSurface}>
            <select aria-label="From" value={JSON.stringify([form.accountId, form.sender])} disabled={disabled}
              onChange={event => { const [accountId, sender] = JSON.parse(event.target.value) as [string, string]; composer.edit({ accountId, sender }); }}>
              {state.accounts.flatMap(account => account.addresses.map(sender => <option key={JSON.stringify([account.id, sender])}
                value={JSON.stringify([account.id, sender])}>{account.name} / {sender}</option>))}
            </select>
          </NeumorphicSurface></label>
          {(['to', 'cc', 'bcc'] as const).map((field, index) => <label key={field} className={styles.field}>{['To', 'Cc', 'Bcc'][index]}
            <NeumorphicTextField aria-label={['To', 'Cc', 'Bcc'][index]} value={form[field]} disabled={disabled}
              placeholder="name@example.com, other@example.com" maxLength={32_000} onChange={event => composer.edit({ [field]: event.target.value })} />
          </label>)}
          <label className={styles.field}>Subject<NeumorphicTextField aria-label="Message subject" value={form.subject} disabled={disabled}
            maxLength={1000} onChange={event => composer.edit({ subject: event.target.value })} /></label>
          <label className={styles.field}>Body<NeumorphicTextField aria-label="Compose message body" multiline rows={12} value={form.body} disabled={disabled}
            maxLength={MAIL_BODY_LIMIT} onChange={event => composer.edit({ body: event.target.value })} /></label>
          {state.reply && <p>This will be sent as a reply to the original message.</p>}
          <div className={styles.toolbar}>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => composer.hide()}>Close and keep draft</NeumorphicButton>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => setDiscard(true)}>Discard draft</NeumorphicButton>
            <NeumorphicButton raised size="standard" disabled={disabled} onClick={() => composer.review()}>Send</NeumorphicButton>
          </div>
          <p>Your draft is kept for the current app session.</p>
          {discard && <div role="alert"><p>Discard this draft?</p><div className={styles.toolbar}>
            <NeumorphicButton size="standard" onClick={() => setDiscard(false)}>Keep editing</NeumorphicButton>
            <NeumorphicButton size="standard" onClick={() => composer.discard()}>Discard</NeumorphicButton>
          </div></div>}
        </>}
      </>}
    </div>
  </Modal>;
}
