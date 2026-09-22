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
  return <Modal title={state.reply ? (state.reply.all ? '전체 답장' : '답장') : '새 메일'} titleIcon={<Send aria-hidden="true" />}
    onClose={() => composer.hide()} closeDisabled={state.busy || state.loading}>
    <div className={styles.form}>
      {state.loading && <p role="status">발신 계정을 확인하는 중…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {form && <>
        {review ? <section className={styles.review} aria-label="발송 전 확인">
          <h3>다음 내용으로 메일을 보낼까요?</h3>
          <dl><dt>보내는 사람</dt><dd>{review.sender}</dd><dt>받는 사람</dt><dd>{review.to.join(', ') || '없음'}</dd>
            <dt>참조</dt><dd>{review.cc.join(', ') || '없음'}</dd><dt>숨은 참조</dt><dd>{review.bcc.join(', ') || '없음'}</dd>
            <dt>제목</dt><dd>{review.subject || '(제목 없음)'}</dd></dl>
          <pre className={styles.bodyText}>{review.body || '(본문 없음)'}</pre>
          <div className={styles.toolbar}>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => composer.back()}>계속 수정</NeumorphicButton>
            <NeumorphicButton raised size="standard" disabled={state.busy} onClick={() => void composer.send()}>
              {state.busy ? '발송 요청 중…' : '확인하고 보내기'}</NeumorphicButton>
          </div>
        </section> : <>
          <label className={styles.field}>보내는 사람<NeumorphicSurface raised highlightFocus className={styles.selectSurface}>
            <select aria-label="보내는 사람" value={JSON.stringify([form.accountId, form.sender])} disabled={disabled}
              onChange={event => { const [accountId, sender] = JSON.parse(event.target.value) as [string, string]; composer.edit({ accountId, sender }); }}>
              {state.accounts.flatMap(account => account.addresses.map(sender => <option key={JSON.stringify([account.id, sender])}
                value={JSON.stringify([account.id, sender])}>{account.name} / {sender}</option>))}
            </select>
          </NeumorphicSurface></label>
          {(['to', 'cc', 'bcc'] as const).map((field, index) => <label key={field} className={styles.field}>{['받는 사람', '참조', '숨은 참조'][index]}
            <NeumorphicTextField aria-label={['받는 사람', '참조', '숨은 참조'][index]} value={form[field]} disabled={disabled}
              placeholder="name@example.com, other@example.com" maxLength={32_000} onChange={event => composer.edit({ [field]: event.target.value })} />
          </label>)}
          <label className={styles.field}>제목<NeumorphicTextField aria-label="메일 제목" value={form.subject} disabled={disabled}
            maxLength={1000} onChange={event => composer.edit({ subject: event.target.value })} /></label>
          <label className={styles.field}>본문<NeumorphicTextField aria-label="작성 본문" multiline rows={12} value={form.body} disabled={disabled}
            maxLength={MAIL_BODY_LIMIT} onChange={event => composer.edit({ body: event.target.value })} /></label>
          {state.reply && <p>원문에 연결된 답장으로 전송합니다.</p>}
          <div className={styles.toolbar}>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => composer.hide()}>내용 유지하고 닫기</NeumorphicButton>
            <NeumorphicButton size="standard" disabled={state.busy} onClick={() => setDiscard(true)}>작성 취소</NeumorphicButton>
            <NeumorphicButton raised size="standard" disabled={disabled} onClick={() => composer.review()}>보내기</NeumorphicButton>
          </div>
          <p>작성 내용은 현재 앱을 사용하는 동안 유지됩니다.</p>
          {discard && <div role="alert"><p>작성 중인 내용을 버릴까요?</p><div className={styles.toolbar}>
            <NeumorphicButton size="standard" onClick={() => setDiscard(false)}>계속 작성</NeumorphicButton>
            <NeumorphicButton size="standard" onClick={() => composer.discard()}>버리기</NeumorphicButton>
          </div></div>}
        </>}
      </>}
    </div>
  </Modal>;
}
