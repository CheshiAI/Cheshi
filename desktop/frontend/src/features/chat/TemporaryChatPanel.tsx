import { Bot, ChevronDown, MessageCircleDashed, Paperclip } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LoadingIndicator, NeumorphicButton, SidebarPanelHeader, draggableWindowRegionStyle } from '../../shared/ui';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { syncChatComposerOverlayHeight } from './chatComposerOverlay';
import { ChatTimeline } from './ChatTimeline';
import { ChatViewSurface } from './ChatViewSurface';
import { ChatComposerSurface, ChatComposerInput, ChatComposerDisclaimer } from './ChatComposerSurface';
import { ChatComposerAttachments } from './ChatComposerAttachments';
import { ChatSubmitButton } from './ChatSubmitButton';
import { ChatErrorNotice } from './ChatErrorNotice';
import { formatReasoningEffort } from './chatViewModel';
import { initialTemporaryChatState, TemporaryChatSession } from './temporaryChatSession';
import { INITIAL_CHAT_STATE } from './model';
import { temporaryChatItems } from './temporaryChatTimeline';
import styles from './TemporaryChatPanel.module.css';
import composer from './ChatComposer.module.css';
import { TemporaryChatConfigurationMenu } from './TemporaryChatConfigurationMenu';
import { chatDroppedFiles, chatTransferFiles, hasChatTransferFiles } from './attachmentTransferModel';

/** Native-window content using the same chat presentation modules as the workspace. */
export function TemporaryChatPanel() {
  const configurationId = useId();
  const [state, setState] = useState(initialTemporaryChatState);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const closeConfiguration = useCallback(() => setConfigurationOpen(false), []);
  const session = useRef<TemporaryChatSession | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const configurationRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const model = state.models.find(option => option.model === state.model);
  const locked = state.loading || state.busy || state.failed;
  const scrollbars = useAutoHideScrollbars<HTMLDivElement>();
  const scrollToBottom = useCallback(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
    followLatest.current = true; setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    const api = cheshiDesktop?.temporaryChat;
    const active = api ? new TemporaryChatSession(api, crypto.randomUUID(), setState) : null;
    session.current = active;
    let mounted = true;
    let autoSend = false;
    let unsubscribeOpened = () => {};
    if (active && api) {
      unsubscribeOpened = api.onOpened(() => {
        if (!mounted || !autoSend) return;
        autoSend = false;
        void active.send().catch(error => console.error('Could not send temporary chat.', error));
      });
      const started = active.start();
      void (async () => {
        try {
          const draft = await api.initialDraft();
          if (draft) {
            await started;
            if (!mounted) return;
            await active.receiveDraft(draft);
            if (!mounted) return;
            await api.acceptDraft();
            autoSend = true;
          }
          if (mounted) window.dispatchEvent(new Event('cheshi:workspace-content-ready'));
        } catch (error) {
          if (mounted) await api.acceptDraft(error instanceof Error ? error.message : String(error));
        }
      })().catch(error => console.error('Could not initialize temporary chat.', error));
    } else setState({ ...initialTemporaryChatState(), loading: false, failed: true, error: 'Temporary chat is unavailable in this window.' });
    textareaRef.current?.focus();
    return () => {
      mounted = false;
      unsubscribeOpened();
      session.current = null;
      if (active) void active.close().catch(error => console.error('Could not close temporary chat.', error));
    };
  }, []);
  useLayoutEffect(() => {
    const root = rootRef.current, area = composerRef.current;
    if (!root || !area) return;
    const sync = () => syncChatComposerOverlayHeight(root, area.getBoundingClientRect().height, timelineRef.current, followLatest.current);
    sync(); const observer = new ResizeObserver(sync); observer.observe(area);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
  }, [state.draft]);
  useLayoutEffect(() => { if (followLatest.current) scrollToBottom(); }, [state.messages, state.busy, scrollToBottom]);
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const onScroll = () => {
      const bottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 32;
      followLatest.current = bottom; setShowScrollToBottom(!bottom);
    };
    timeline.addEventListener('scroll', onScroll);
    return () => timeline.removeEventListener('scroll', onScroll);
  }, []);
  const items = useMemo(() => temporaryChatItems(state.messages), [state.messages]);
  const submit = () => { setConfigurationOpen(false); followLatest.current = true; void session.current?.send(); };

  return <div className={`app-shell ${styles.window}`} ref={scrollbars}>
    <header className={styles.titlebar} style={draggableWindowRegionStyle}>
      <SidebarPanelHeader title="TEMPORARY CHAT" icon={<MessageCircleDashed aria-hidden="true" />} />
    </header>
    <p className={styles.description}>Not saved to chat history · Ends when closed</p>
    <main className={`workspace-column ${styles.content}`}>
      <ChatViewSurface rootRef={rootRef} timelineRef={timelineRef}
        onKeyDown={event => {
          if (event.key === 'Escape' && configurationOpen && !event.nativeEvent.isComposing) {
            event.preventDefault(); closeConfiguration(); configurationRef.current?.querySelector('button')?.focus();
          }
        }}
        onDragOver={event => {
          if (!hasChatTransferFiles(event.dataTransfer)) return;
          event.preventDefault(); event.stopPropagation();
          event.dataTransfer.dropEffect = locked || state.picking ? 'none' : 'copy';
        }}
        onDrop={event => {
          if (!hasChatTransferFiles(event.dataTransfer)) return;
          event.preventDefault(); event.stopPropagation();
          if (!locked && !state.picking) { closeConfiguration(); void session.current?.importAttachments(chatDroppedFiles(event.dataTransfer)); }
        }}>
        <ChatTimeline controller={{ loading: state.loading, streaming: state.busy, timelineRef,
          state: { ...INITIAL_CHAT_STATE, sessionsLoading: false, activeTitle: 'Temporary chat', items },
          workspaceName: 'Temporary chat', showScrollToBottom, scrollToBottom,
          pauseAutoScroll: () => { followLatest.current = false; } }} onReviewFileChanges={() => {}} />
        <footer className={composer.composerArea} ref={composerRef}>
          {state.error && <ChatErrorNotice className={composer.error}>{state.error}</ChatErrorNotice>}
          <ChatComposerSurface onSubmit={event => { event.preventDefault(); submit(); }}>
            <ChatComposerAttachments attachments={state.attachments} removeAttachment={path => session.current?.removeAttachment(path)} />
            <ChatComposerInput ref={textareaRef} aria-label="Temporary chat message" placeholder="Ask anything…"
              value={state.draft} readOnly={state.busy || state.failed} disabled={state.loading}
              onChange={event => session.current?.setDraft(event.target.value)} onFocus={closeConfiguration}
              onPaste={event => {
                const files = chatTransferFiles(event.clipboardData);
                if (files.length && !locked && !state.picking) { event.preventDefault(); void session.current?.importAttachments(files); }
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault(); submit();
                }
              }} />
            <div className={composer.composerFooter}>
              <div className={composer.composerMeta}>
                <NeumorphicButton variant="standard" size="icon" className={composer.attachmentButton} disabled={locked || state.picking}
                  title="Attach files" aria-label="Attach files" onClick={() => void session.current?.selectAttachments()}>
                  {state.picking ? <LoadingIndicator label="Opening attachment picker" /> : <Paperclip aria-hidden="true" />}
                </NeumorphicButton>
              </div>
              <div className={composer.composerActions}>
                <div className={composer.configurationTriggerAnchor} ref={configurationRef}>
                  <NeumorphicButton variant="standard" aria-label="Choose model and reasoning effort" aria-haspopup="menu"
                    aria-expanded={configurationOpen} aria-controls={configurationOpen ? configurationId : undefined}
                    disabled={locked || state.picking} className={composer.configurationTrigger} active={configurationOpen}
                    onClick={() => setConfigurationOpen(!configurationOpen)}>
                    <Bot aria-hidden="true" /><span className={composer.configurationTriggerModel}>{model?.displayName ?? 'Loading models…'}</span>
                    <span className={composer.configurationTriggerEffort}>{formatReasoningEffort(state.effort)}</span>
                    <ChevronDown aria-hidden="true" className={composer.configurationChevron} />
                  </NeumorphicButton>
                </div>
                <ChatSubmitButton streaming={false} goalEditorOpen={false} onStop={() => {}}
                  sendDisabled={locked || state.picking || (!state.draft.trim() && state.attachments.length === 0)} />
              </div>
            </div>
          </ChatComposerSurface>
          <ChatComposerDisclaimer />
        </footer>
        {configurationOpen && <TemporaryChatConfigurationMenu id={configurationId} trigger={configurationRef}
          models={state.models} model={state.model} effort={state.effort} disabled={locked || state.picking}
          onModelChange={value => session.current?.selectModel(value)} onEffortChange={value => session.current?.selectEffort(value)}
          onClose={closeConfiguration} />}
      </ChatViewSurface>
    </main>
  </div>;
}
