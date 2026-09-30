import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Mail, PanelRight, Flag } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { EmptyState, SidebarPanelHeader, SidebarToggle, LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { AppleMailApi } from '../../../../shared/apple-mail';
import { MailModel } from './mailModel';
import { mailComposer } from './mailComposer';
import { MailComposerDialog } from './MailComposerDialog';
import { MailActions } from './MailActions';
import { MailSidebar } from './MailSidebar';
import styles from './Mail.module.css';

interface MailViewProps {
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  active?: boolean;
  sidebarTarget?: HTMLElement | null;
  onOpen?: () => void;
}
function received(date: string | null) { return date ? new Date(date).toLocaleString() : '날짜 없음'; }

function MailHeader({ rightSidebarOpen, onToggleRightSidebar }: MailViewProps) {
  return <SidebarPanelHeader title="MAIL" icon={<Mail aria-hidden="true" />} actions={<>
    <SidebarToggle raised size="icon" aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
      aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></SidebarToggle>
  </>} />;
}

export function MailView(props: MailViewProps) {
  const api = cheshiDesktop?.appleMail;
  return api?.available ? <MailBrowser api={api} {...props} />
    : <main className={styles.workspace} aria-label="Mail" hidden={props.active === false}>
      <MailHeader {...props} />
      <div className={styles.connect}><EmptyState className={styles.emptyState} title="Mail"
        description="Apple Mail integration is available in Cheshi for macOS." /></div>
      {props.sidebarTarget && createPortal(<>
        <SidebarPanelHeader title="MAIL" icon={<Mail aria-hidden="true" />} />
        <p className={styles.notice}>Apple Mail integration is available in Cheshi for macOS.</p>
      </>, props.sidebarTarget)}
    </main>;
}

export function MailBrowser({ api, rightSidebarOpen, onToggleRightSidebar, active = true, sidebarTarget, onOpen }: MailViewProps & { api: AppleMailApi }) {
  const model = useMemo(() => new MailModel(api), [api]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const composer = useMemo(() => mailComposer(api), [api]);
  const composition = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  useEffect(() => {
    let disposed = false;
    // Defer past Strict Mode's setup/cleanup replay so startup issues a single request.
    queueMicrotask(() => { if (!disposed) void model.connect(); });
    return () => { disposed = true; model.cancelPending(); };
  }, [model]);
  const busy = state.loadingBoxes || state.loadingPage || state.changing;
  return <main className={styles.workspace} aria-label="Mail" hidden={!active}>
    <MailHeader rightSidebarOpen={rightSidebarOpen} onToggleRightSidebar={onToggleRightSidebar} />
    {sidebarTarget && createPortal(<MailSidebar state={state} composing={composition.form !== null}
      onRefresh={() => model.connect()} onCompose={() => void composer.start()}
      onSelect={box => {
        onOpen?.();
        if (!state.selectedBox || mailboxKey(box) !== mailboxKey(state.selectedBox)) void model.selectMailbox(box);
      }} />, sidebarTarget)}
    {composition.notice && <p className={styles.notice} role="status">{composition.notice}</p>}
    {state.changeError && <p className={styles.notice} role="alert">{state.changeError}</p>}
    {!state.connected ? <div className={styles.connect}>
      <EmptyState className={styles.emptyState} title="Mail" description="Browse your mailboxes and messages from Apple Mail." />
      {state.boxesError && <p role="alert">{state.boxesError}</p>}
      <NeumorphicButton variant="standard" disabled={state.loadingBoxes} onClick={() => void model.connect()}>
        {state.loadingBoxes ? 'Connecting…' : 'Connect Apple Mail'}
      </NeumorphicButton>
    </div> : <div className={styles.browser}>
      <LiquidGlassPanel as="section" className={styles.messages} aria-label="메일 목록" aria-busy={busy}>
        <h2 className={styles.listTitle}>{state.selectedBox?.path.at(-1) ?? '메일'}</h2>
        <div className={styles.messageList}>
          {state.pageError && state.page && <p className={styles.notice} role="alert">{state.pageError}</p>}
          {state.loadingBoxes && !state.page ? null
            : busy && !state.page ? <p className={styles.notice} role="status">메일을 불러오는 중…</p>
            : state.pageError && !state.page ? <div className={styles.notice}><p role="alert">{state.pageError}</p>
              <NeumorphicButton size="standard" onClick={() => state.selectedBox && void model.selectMailbox(state.selectedBox)}>다시 시도</NeumorphicButton></div>
            : state.page?.messages.length === 0 ? <p className={styles.notice} role="status">메일이 없습니다.</p>
            : state.page?.messages.map(message => <button key={message.id} type="button" className={styles.messageRow}
              disabled={state.changing} aria-disabled={state.loadingBoxes || undefined}
              aria-pressed={state.selectedId === message.id} onClick={() => void model.selectMessage(message.id)}>
              <span className={styles.sender}>{!message.read && <span className={styles.unread} aria-label="읽지 않음">●</span>}{message.sender || '발신자 없음'}</span>
              {message.flagged && <Flag className={styles.flag} aria-label="깃발 있음" />}
              <span className={styles.subject}>{message.subject || '(제목 없음)'}</span>
              <time dateTime={message.date ?? undefined}>{received(message.date)}</time>
            </button>)}
        </div>
        <div className={styles.pagination}>
          <NeumorphicButton size="icon" aria-label="이전 메일 페이지" disabled={busy || !state.page || state.page.offset === 0}
            onClick={() => void model.previousPage()}><ChevronLeft aria-hidden="true" /></NeumorphicButton>
          <span>{state.page && state.page.messages.length > 0 ? `${state.page.offset + 1}–${state.page.offset + state.page.messages.length}` : ''}</span>
          <NeumorphicButton size="icon" aria-label="다음 메일 페이지" disabled={busy || state.page?.nextOffset == null}
            onClick={() => void model.nextPage()}><ChevronRight aria-hidden="true" /></NeumorphicButton>
        </div>
      </LiquidGlassPanel>
      <LiquidGlassPanel as="article" className={styles.body} aria-label="메일 본문" aria-busy={state.loadingBody}>
        {state.loadingBody ? <p role="status">본문을 불러오는 중…</p>
          : state.bodyError ? <><p role="alert">{state.bodyError}</p><NeumorphicButton size="standard"
            onClick={() => state.selectedId !== null && void model.selectMessage(state.selectedId)}>본문 다시 시도</NeumorphicButton></>
          : state.message ? <>
            {state.selectedBox && <MailActions key={`${mailboxKey(state.selectedBox)}:${state.message.id}`} message={state.message}
              target={{ mailbox: state.selectedBox, id: state.message.id }} boxes={state.boxes} disabled={busy || state.changeBlocked}
              onChange={input => model.change(input)} onReply={all => void composer.start(state.message!,
                { mailbox: state.selectedBox!, id: state.message!.id }, all)} />}
            <h2 className={styles.bodyTitle}>{state.message.subject || '(제목 없음)'}</h2>
            <p>{state.message.sender || '발신자 없음'}</p>
            <p>받는 사람: {state.message.to.join(', ') || '없음'}</p>
            {state.message.cc.length > 0 && <p>참조: {state.message.cc.join(', ')}</p>}
            <time dateTime={state.message.date ?? undefined}>{received(state.message.date)}</time>
            {state.message.bodyTruncated && <p role="status">본문이 길어 일부만 표시합니다. 전체 내용은 Apple Mail에서 확인해 주세요.</p>}
            <pre className={styles.bodyText}>{state.message.body || '(본문 없음)'}</pre>
          </> : <p role="status">메일을 선택하면 본문이 표시됩니다.</p>}
      </LiquidGlassPanel>
    </div>}
    <MailComposerDialog composer={composer} />
  </main>;
}
