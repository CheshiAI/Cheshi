import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Mail, PanelRight, Flag } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { EmptyState, SidebarPanelHeader, SidebarToggle, LiquidGlassPanel, LoadingState, NeumorphicButton } from '../../shared/ui';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { AppleMailApi } from '../../../../shared/apple-mail';
import { MailModel } from './mailModel';
import { mailComposer } from './mailComposer';
import { MailComposerDialog } from './MailComposerDialog';
import { MailActions } from './MailActions';
import { MailSidebar } from './MailSidebar';
import { useMailInfiniteScroll } from './useMailInfiniteScroll';
import styles from './Mail.module.css';

interface MailViewProps {
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  active?: boolean;
  sidebarTarget?: HTMLElement | null;
  onOpen?: () => void;
}
function received(date: string | null) { return date ? new Date(date).toLocaleString() : 'Date unavailable'; }

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
  const { viewportRef, moreRef } = useMailInfiniteScroll(model, state, active);
  const composer = useMemo(() => mailComposer(api), [api]);
  const composition = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  useEffect(() => {
    let disposed = false;
    // Defer past Strict Mode's setup/cleanup replay so startup issues a single request.
    queueMicrotask(() => { if (!disposed) void model.connect(); });
    return () => { disposed = true; model.cancelPending(); };
  }, [model]);
  const busy = state.loadingBoxes || state.loadingPage || state.changing;
  const listLoadingLabel = state.loadingMore ? 'Loading more messages…'
    : busy && !state.loadingBoxes && !state.page ? 'Loading messages…' : null;
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
      <LiquidGlassPanel as="section" className={styles.messages} aria-label="Message list" aria-busy={busy || state.loadingMore}>
        <h2 className={styles.listTitle}>{state.selectedBox?.path.at(-1) ?? 'Mail'}</h2>
        <div className={styles.messageViewport}>
          <div ref={viewportRef} className={styles.messageList}>
            {state.pageError && state.page && <p className={styles.notice} role="alert">{state.pageError}</p>}
            {busy && !state.page ? null
              : state.pageError && !state.page ? <div className={styles.notice}><p role="alert">{state.pageError}</p>
                <NeumorphicButton size="standard" onClick={() => state.selectedBox && void model.selectMailbox(state.selectedBox)}>Retry</NeumorphicButton></div>
              : state.page?.messages.length === 0 ? <p className={`${styles.emptyMessage} ${styles.description}`} role="status">No messages.</p>
              : state.page?.messages.map(message => <button key={message.id} type="button" className={styles.messageRow}
                disabled={state.changing} aria-disabled={state.loadingBoxes || undefined}
                data-unread={!message.read} aria-description={message.read ? undefined : 'Unread'}
                aria-pressed={state.selectedId === message.id} onClick={() => void model.selectMessage(message.id)}>
                <span className={styles.sender}>{message.sender || 'Unknown sender'}</span>
                {message.flagged && <Flag className={styles.flag} aria-label="Flagged" />}
                <span className={styles.subject}>{message.subject || '(No subject)'}</span>
                <time dateTime={message.date ?? undefined}>{received(message.date)}</time>
              </button>)}
            {state.page?.nextOffset != null && <div ref={moreRef} className={styles.moreSentinel} aria-hidden="true" />}
            {state.moreError && <div className={styles.notice}>
              <p role="alert">{state.moreError}</p>
              <NeumorphicButton variant="standard" onClick={() => void model.loadMore()}>Retry loading more</NeumorphicButton>
            </div>}
          </div>
          {listLoadingLabel && <LoadingState className={`${styles.loadingOverlay} ${styles.descriptionLoading}`} label={listLoadingLabel} />}
        </div>
      </LiquidGlassPanel>
      <LiquidGlassPanel as="article" className={styles.body} aria-label="Message body" aria-busy={state.loadingBody}>
        {state.loadingBody ? <LoadingState className={`${styles.loadingOverlay} ${styles.descriptionLoading}`} label="Loading message…" />
          : state.bodyError ? <><p role="alert">{state.bodyError}</p><NeumorphicButton size="standard"
            onClick={() => state.selectedId !== null && void model.selectMessage(state.selectedId)}>Retry loading message</NeumorphicButton></>
          : state.message ? <>
            {state.selectedBox && <MailActions key={`${mailboxKey(state.selectedBox)}:${state.message.id}`} message={state.message}
              target={{ mailbox: state.selectedBox, id: state.message.id }} boxes={state.boxes} disabled={busy || state.changeBlocked}
              onChange={input => model.change(input)} onReply={all => void composer.start(state.message!,
                { mailbox: state.selectedBox!, id: state.message!.id }, all)} />}
            <h2 className={styles.bodyTitle}>{state.message.subject || '(No subject)'}</h2>
            <p>{state.message.sender || 'Unknown sender'}</p>
            <p>To: {state.message.to.join(', ') || 'None'}</p>
            {state.message.cc.length > 0 && <p>Cc: {state.message.cc.join(', ')}</p>}
            <time dateTime={state.message.date ?? undefined}>{received(state.message.date)}</time>
            {state.message.bodyTruncated && <p role="status">Only part of this long message is shown. Open Apple Mail to view the full content.</p>}
            <pre className={state.message.body ? styles.bodyText : `${styles.bodyText} ${styles.description}`}>{state.message.body || '(No content)'}</pre>
          </> : <p className={`${styles.emptyMessage} ${styles.description}`} role="status">Select a message to view its content.</p>}
      </LiquidGlassPanel>
    </div>}
    <MailComposerDialog composer={composer} />
  </main>;
}
