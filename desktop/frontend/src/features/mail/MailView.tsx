import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Mail, Flag, X } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { EmptyState, SidebarPanelHeader, LiquidGlassPanel, LoadingState, NeumorphicButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { AppleMailApi } from '../../../../shared/apple-mail';
import { MailModel } from './mailModel';
import { mailComposer } from './mailComposer';
import { MailComposerDialog } from './MailComposerDialog';
import { MailInlineReply } from './MailInlineReply';
import { MailActions } from './MailActions';
import { MailMessageContent } from './MailMessageContent';
import { MailConversationView } from './MailConversationView';
import { MailSidebar } from './MailSidebar';
import { useMailInfiniteScroll } from './useMailInfiniteScroll';
import styles from './Mail.module.css';

interface MailViewProps {
  active?: boolean;
  sidebarTarget?: HTMLElement | null;
  onOpen?: () => void;
  onClose?: () => void;
}
function received(date: string | null) { return date ? new Date(date).toLocaleString() : 'Date unavailable'; }

export function MailView(props: MailViewProps) {
  const api = cheshiDesktop?.appleMail;
  return api?.available ? <MailBrowser api={api} {...props} />
    : <main className={styles.workspace} aria-label="Mail" hidden={props.active === false}>
      {props.onClose && <div className={styles.messageToolbar}>
        <TooltipButton variant="ghost" size="icon" aria-label="Close mail" title="Close mail" onClick={props.onClose}>
          <X aria-hidden="true" />
        </TooltipButton>
      </div>}
      <div className={styles.connect}><EmptyState className={styles.emptyState} title="Mail"
        description="Apple Mail integration is available in Cheshi for macOS." /></div>
      {props.sidebarTarget && createPortal(<>
        <SidebarPanelHeader title="MAIL" icon={<Mail aria-hidden="true" />} />
        <p className={styles.notice}>Apple Mail integration is available in Cheshi for macOS.</p>
      </>, props.sidebarTarget)}
    </main>;
}

export function MailBrowser({ api, active = true, sidebarTarget, onOpen, onClose }: MailViewProps & { api: AppleMailApi }) {
  const model = useMemo(() => new MailModel(api), [api]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const { viewportRef, moreRef } = useMailInfiniteScroll(model, state, active);
  const composer = useMemo(() => mailComposer(api), [api]);
  const composition = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const inlineReply = composition.visible && composition.reply !== null;
  const replyLocked = inlineReply && (composition.busy || composition.loading);
  useEffect(() => {
    let disposed = false;
    // Defer past Strict Mode's setup/cleanup replay so startup issues a single request.
    queueMicrotask(() => { if (!disposed) void model.connect(); });
    return () => { disposed = true; model.cancelPending(); };
  }, [model]);
  useEffect(() => {
    if (composition.notice) void model.refreshConversation();
  }, [composition.notice, model]);
  const busy = state.loadingBoxes || state.loadingPage || state.changing;
  const listLoadingLabel = state.loadingMore ? 'Loading more messages…'
    : busy && !state.loadingBoxes && !state.page ? 'Loading messages…' : null;
  const actions = <MailActions key={`${state.selectedBox ? mailboxKey(state.selectedBox) : ''}:${state.message?.id ?? ''}`}
    message={state.message} target={state.selectedBox && state.message ? { mailbox: state.selectedBox, id: state.message.id } : null}
    boxes={state.boxes} disabled={busy || state.loadingBody || state.changeBlocked || inlineReply} onClose={onClose}
    onChange={input => model.change(input)} onReply={all => {
      if (state.message && state.selectedBox) void composer.start(state.message,
        { mailbox: state.selectedBox, id: state.message.id }, all, state.remoteImagesAllowed);
    }} />;
  return <main className={styles.workspace} aria-label="Mail" hidden={!active}>
    {sidebarTarget && createPortal(<MailSidebar state={state} composing={composition.form !== null}
      onRefresh={() => model.connect()} onCompose={() => void composer.start()}
      onSelect={box => {
        if (replyLocked) return;
        onOpen?.();
        if (!state.selectedBox || mailboxKey(box) !== mailboxKey(state.selectedBox)) {
          if (inlineReply) composer.hide();
          void model.selectMailbox(box);
        }
      }} />, sidebarTarget)}
    {composition.notice && <div className={`${styles.notice} ${styles.sendNotice}`}>
      <p className={styles.description} role="status">{composition.notice}</p>
      <TooltipButton size="icon" title="Dismiss send notification" aria-label="Dismiss send notification" onClick={composer.dismissNotice}>
        <X aria-hidden="true" />
      </TooltipButton>
    </div>}
    {state.changeError && <p className={styles.notice} role="alert">{state.changeError}</p>}
    {!state.connected ? <>{actions}<div className={styles.connect}>
      <EmptyState className={styles.emptyState} title="Mail" description="Browse your mailboxes and messages from Apple Mail." />
      {state.boxesError && <p role="alert">{state.boxesError}</p>}
      <NeumorphicButton variant="standard" disabled={state.loadingBoxes} onClick={() => void model.connect()}>
        {state.loadingBoxes ? 'Connecting…' : 'Connect Apple Mail'}
      </NeumorphicButton>
    </div></> : <div className={styles.browser}>
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
                disabled={state.changing || replyLocked} aria-disabled={state.loadingBoxes || undefined}
                data-unread={!message.read} aria-description={message.read ? undefined : 'Unread'}
                aria-pressed={state.selectedId === message.id} onClick={() => {
                  if (inlineReply) composer.hide();
                  void model.selectMessage(message.id);
                }}>
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
      <LiquidGlassPanel as="article" className={`${styles.body} ${inlineReply || state.message?.html || (state.conversation?.messages.length ?? 0) > 1 ? styles.htmlBody : ''}`} aria-label="Message body" aria-busy={!inlineReply && (state.loadingBody || state.loadingConversation)}>
        {actions}
        {inlineReply ? <MailInlineReply composer={composer} active={active} onLoadImages={() => {
          composer.allowRemoteImages();
          const target = composition.reply?.target;
          if (target && target.id === state.message?.id && state.selectedBox
            && mailboxKey(target.mailbox) === mailboxKey(state.selectedBox)) model.allowRemoteImages();
          else if (target) model.allowConversationImages(target);
        }} /> : state.loadingBody ? <LoadingState className={`${styles.loadingOverlay} ${styles.descriptionLoading}`} label="Loading message…" />
          : state.bodyError ? <><p role="alert">{state.bodyError}</p><NeumorphicButton size="standard"
            onClick={() => state.selectedId !== null && void model.selectMessage(state.selectedId)}>Retry loading message</NeumorphicButton></>
          : state.message ? <MailConversationView model={model} state={state} composer={composer}>
            <MailMessageContent key={`${state.selectedBox ? mailboxKey(state.selectedBox) : ''}:${state.message.id}`}
              message={state.message} remoteImagesAllowed={state.remoteImagesAllowed}
              padded={(state.conversation?.messages.length ?? 0) > 1} onLoadImages={model.allowRemoteImages} />
          </MailConversationView> : <p className={`${styles.emptyMessage} ${styles.description}`} role="status">Select a message to view its content.</p>}
      </LiquidGlassPanel>
    </div>}
    <MailComposerDialog composer={composer} />
  </main>;
}
