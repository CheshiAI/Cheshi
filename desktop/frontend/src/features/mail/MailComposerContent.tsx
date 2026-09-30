import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MailReplyEditor } from './MailReplyEditor';
import { MailHtmlBody } from './MailHtmlBody';
import { MAIL_BODY_LIMIT } from '../../../../shared/apple-mail';
import { NeumorphicButton, NeumorphicSurface, NeumorphicTextField } from '../../shared/ui';
import type { MailComposer } from './mailComposer';
import styles from './Mail.module.css';
import replyStyles from './MailInlineReply.module.css';

export function MailComposerContent({ composer, inline = false, active = true, onLoadImages = () => composer.allowRemoteImages() }: {
  composer: MailComposer; inline?: boolean; active?: boolean; onLoadImages?: () => void;
}) {
  const state = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const [discard, setDiscard] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const form = state.form;
  const disabled = state.busy || state.blocked;
  const review = state.confirmation;
  const ready = !!form && !review && !disabled;
  useEffect(() => {
    if (!inline || !active || !ready) return;
    bodyRef.current?.focus();
  }, [inline, active, ready]);
  const fieldClass = inline ? replyStyles.row : styles.field;
  const senderField = form && <label className={fieldClass}>From
    <NeumorphicSurface raised highlightFocus className={styles.selectSurface}>
      <select aria-label="From" value={JSON.stringify([form.accountId, form.sender])} disabled={disabled}
        onChange={event => { const [accountId, sender] = JSON.parse(event.target.value) as [string, string]; composer.edit({ accountId, sender }); }}>
        {state.accounts.flatMap(account => account.addresses.map(sender => <option key={JSON.stringify([account.id, sender])}
          value={JSON.stringify([account.id, sender])}>{account.name} / {sender}</option>))}
      </select>
    </NeumorphicSurface>
  </label>;
  return (
    <div className={inline ? replyStyles.form : styles.form}>
      {state.loading && <p role="status">Checking sending accounts…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {form && <>
        {review ? <section className={styles.review} aria-label="Review before sending">
          <h3>Send this message?</h3>
          <dl><dt>From</dt><dd>{review.sender}</dd><dt>To</dt><dd>{review.to.join(', ') || 'None'}</dd>
            <dt>Cc</dt><dd>{review.cc.join(', ') || 'None'}</dd><dt>Bcc</dt><dd>{review.bcc.join(', ') || 'None'}</dd>
            <dt>Subject</dt><dd>{review.subject || '(No subject)'}</dd></dl>
          {review.html && state.original ? <MailHtmlBody message={{ ...state.original, html: review.html, inlineImages: [] }}
            remoteImages={state.remoteImagesAllowed} onLoadImages={onLoadImages} />
            : <pre className={styles.bodyText}>{review.body || '(No content)'}</pre>}
          <div className={styles.toolbar}>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => composer.back()}>Continue editing</NeumorphicButton>
            <NeumorphicButton raised size="standard" disabled={state.busy} onClick={() => void composer.send()}>
              {state.busy ? 'Sending…' : 'Confirm and send'}</NeumorphicButton>
          </div>
        </section> : <>
          {!inline && senderField}
          {(['to', 'cc', 'bcc'] as const).map((field, index) => <label key={field} className={fieldClass}>{['To', 'Cc', 'Bcc'][index]}
            <NeumorphicTextField aria-label={['To', 'Cc', 'Bcc'][index]} value={form[field]} disabled={disabled}
              placeholder="name@example.com, other@example.com" maxLength={32_000} onChange={event => composer.edit({ [field]: event.target.value })} />
          </label>)}
          <label className={fieldClass}>Subject<NeumorphicTextField aria-label="Message subject" value={form.subject} disabled={disabled}
            maxLength={1000} onChange={event => composer.edit({ subject: event.target.value })} /></label>
          {inline && senderField}
          {inline && form.html !== undefined ? <MailReplyEditor html={form.html} disabled={disabled} active={active}
            remoteImages={state.remoteImagesAllowed} onLoadImages={onLoadImages} onChange={(html, body) => composer.edit({ html, body })} />
            : <label className={styles.field}>Body<NeumorphicTextField ref={bodyRef} aria-label="Compose message body" multiline rows={12} value={form.body} disabled={disabled}
              maxLength={MAIL_BODY_LIMIT} onChange={event => composer.edit({ body: event.target.value })} /></label>}
          <div className={inline ? replyStyles.actions : styles.toolbar}>
            <NeumorphicButton variant="ghost" size="standard" disabled={state.busy} onClick={() => composer.hide()}>Close and keep draft</NeumorphicButton>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => setDiscard(true)}>Discard draft</NeumorphicButton>
            <NeumorphicButton raised size="standard" disabled={disabled} onClick={() => composer.review()}>Send</NeumorphicButton>
          </div>
          <p className={inline ? replyStyles.hint : undefined}>Your draft is kept for the current app session.</p>
          {discard && <div role="alert"><p>Discard this draft?</p><div className={styles.toolbar}>
            <NeumorphicButton size="standard" onClick={() => setDiscard(false)}>Keep editing</NeumorphicButton>
            <NeumorphicButton size="standard" onClick={() => composer.discard()}>Discard</NeumorphicButton>
          </div></div>}
        </>}
      </>}
    </div>
  );
}
