import { ArrowUp, Bot, LoaderCircle, MessageCircleDashed, Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { cheshiDesktop } from '../../cheshiDesktop';
import { LiquidGlassPanel, LoadingState, NeumorphicButton, NeumorphicTextField, PillDropdownButton } from '../../shared/ui';
import toastStyles from '../../shared/ui/DismissibleToast.module.css';
import { MessageContent } from './MessageContent';
import { ChatMessageLabel } from './ChatMessageLabel';
import { formatReasoningEffort } from './chatViewModel';
import { initialTemporaryChatState, TemporaryChatSession } from './temporaryChatSession';
import styles from './TemporaryChatPanel.module.css';
import { TemporaryChatConfigurationMenu } from './TemporaryChatConfigurationMenu';
import { chatDroppedFiles, hasChatTransferFiles } from './attachmentTransferModel';

export function TemporaryChatPanel({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const configurationId = useId();
  const [state, setState] = useState(initialTemporaryChatState);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const closeConfiguration = useCallback(() => setConfigurationOpen(false), []);
  const session = useRef<TemporaryChatSession | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const configurationRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const model = state.models.find(option => option.model === state.model);
  const locked = state.loading || state.busy || state.failed;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const api = cheshiDesktop?.temporaryChat;
    if (api) {
      const active = new TemporaryChatSession(api, crypto.randomUUID(), setState);
      session.current = active;
      setState(initialTemporaryChatState());
      void active.start();
    } else {
      setState({ ...initialTemporaryChatState(), loading: false, failed: true,
        error: 'Temporary chat is unavailable in this window.' });
    }
    textareaRef.current?.focus();
    return () => {
      const active = session.current;
      session.current = null;
      if (active) void active.close().catch(error => console.error('Could not close temporary chat.', error));
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [state.messages, state.busy]);

  const close = () => {
    const active = session.current;
    if (active) void active.close().catch(error => console.error('Could not close temporary chat.', error));
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (configurationOpen) {
        setConfigurationOpen(false);
        configurationRef.current?.querySelector('button')?.focus();
      } else close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...(rootRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
    ) ?? [])].filter(element => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    <div ref={rootRef} onKeyDown={handleKeyDown}>
      <LiquidGlassPanel
        as="section"
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={`${toastStyles.card} ${styles.card}`}
        data-liquid-glass-backdrop="true"
      >
        <header className={`${toastStyles.header} ${styles.header}`}>
          <span className={toastStyles.icon}><MessageCircleDashed aria-hidden="true" /></span>
          <div className={toastStyles.heading}>
            <h2 id={titleId} className={toastStyles.title}>Temporary chat</h2>
          </div>
          <NeumorphicButton raised className={toastStyles.close} aria-label="Close temporary chat"
            title="Close temporary chat" onClick={close}><X aria-hidden="true" /></NeumorphicButton>
          <div id={descriptionId} className={`${toastStyles.description} ${styles.description}`}>Not saved to chat history · Ends when closed</div>
        </header>
        <div className={`${toastStyles.body} ${styles.messages}`} role="log" aria-label="Temporary conversation" tabIndex={0}>
          {state.messages.length === 0 && <p className={styles.empty}>
            {state.loading ? 'Loading models…' : 'Ask a question. Continue the conversation here until you close this window.'}
          </p>}
          {state.messages.map((message, index) => (
            <article className={styles.message} key={index}>
              <div className={styles.speaker}><ChatMessageLabel author={message.role} createdAt={message.createdAt} /></div>
              {message.text && <MessageContent text={message.text} />}
              {message.attachments.length > 0 && <ul className={styles.fileList} aria-label="Attached files">
                {message.attachments.map(attachment => <li key={attachment.path}>{attachment.name}</li>)}
              </ul>}
            </article>
          ))}
          {state.busy && <LoadingState type="thinking" className={styles.loading} />}
          <div ref={endRef} />
        </div>
        <form className={`${toastStyles.footer} ${styles.composer}`}
          onDragOver={event => {
            if (!hasChatTransferFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = locked || state.picking ? 'none' : 'copy';
          }}
          onDrop={event => {
            if (!hasChatTransferFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            if (locked || state.picking) return;
            setConfigurationOpen(false);
            void session.current?.importAttachments(chatDroppedFiles(event.dataTransfer));
          }} onSubmit={event => {
          event.preventDefault();
          setConfigurationOpen(false);
          void session.current?.send();
        }}>
          {state.error && <p className={styles.error} role="alert">{state.error}</p>}
          {state.attachments.length > 0 && <ul className={styles.attachments} aria-label="Attachments to send">
            {state.attachments.map(attachment => <li key={attachment.path}>
              <span title={attachment.path}>{attachment.name}</span>
              <NeumorphicButton raised className={toastStyles.close} disabled={state.busy}
                aria-label={`Remove ${attachment.name}`} onClick={() => session.current?.removeAttachment(attachment.path)}>
                <X aria-hidden="true" />
              </NeumorphicButton>
            </li>)}
          </ul>}
          <NeumorphicTextField multiline ref={textareaRef} className={styles.input} rows={3}
            aria-label="Temporary chat message" placeholder="Ask anything…" value={state.draft}
            readOnly={state.busy || state.failed} onChange={event => session.current?.setDraft(event.target.value)}
            onFocus={() => setConfigurationOpen(false)}
            onPointerDown={() => setConfigurationOpen(false)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                setConfigurationOpen(false);
                void session.current?.send();
              }
            }} />
          <div className={styles.controls}>
            <NeumorphicButton raised size="icon" className={styles.circle} disabled={locked || state.picking}
              title="Attach files" aria-label="Attach files" onClick={() => void session.current?.selectAttachments()}>
              {state.picking ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
            </NeumorphicButton>
            <div className={styles.configurationAnchor} ref={configurationRef}>
              <PillDropdownButton aria-label="Choose model and reasoning effort" aria-haspopup="menu" aria-expanded={configurationOpen}
                aria-controls={configurationOpen ? configurationId : undefined} disabled={locked || state.picking}
                className={styles.modelTrigger} active={configurationOpen} onClick={() => setConfigurationOpen(!configurationOpen)}>
                <Bot aria-hidden="true" /><span>{model?.displayName ?? 'Loading models…'}</span>
                <span className={styles.effort}>{formatReasoningEffort(state.effort)}</span>
              </PillDropdownButton>
            </div>
            <NeumorphicButton raised size="icon" type="submit" className={styles.circle} aria-label="Send temporary message"
              title="Send message" disabled={locked || state.picking || (!state.draft.trim() && state.attachments.length === 0)}>
              <ArrowUp aria-hidden="true" />
            </NeumorphicButton>
          </div>
        </form>
      </LiquidGlassPanel>
      {configurationOpen && <TemporaryChatConfigurationMenu id={configurationId} trigger={configurationRef}
        models={state.models} model={state.model} effort={state.effort} disabled={locked || state.picking}
        onModelChange={value => session.current?.selectModel(value)}
        onEffortChange={value => session.current?.selectEffort(value)} onClose={closeConfiguration} />}
    </div>, document.body,
  );
}
