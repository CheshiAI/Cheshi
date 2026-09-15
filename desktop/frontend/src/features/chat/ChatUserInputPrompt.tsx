import { ExternalLink, MessageCircleQuestion, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { ChatUserInputRequest, ChatUserInputResponse } from '../../../../shared/chat-user-input';
import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import { ChatMcpFields, ChatQuestionFields } from './ChatUserInputFields';
import { initialInputDraft, inputResponse, userInputLink, type InputDraft } from './chatUserInputForm';
import { useHelpLanguage } from '../../shared/useHelpLanguage';
import { useChatUserInputs } from './useChatUserInputs';
import styles from './ChatUserInputPrompt.module.css';
import { ChatErrorNotice } from './ChatErrorNotice';

export function ChatUserInputPrompt({ request, respond, pending, error, otherThread = false, answerDisabled = false }: {
  request: ChatUserInputRequest;
  respond: (id: string, response: ChatUserInputResponse) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  otherThread?: boolean;
  answerDisabled?: boolean;
}) {
  const [language] = useHelpLanguage();
  const korean = language === 'ko';
  const [draft, setDraft] = useState(() => initialInputDraft(request));
  const [notes, setNotes] = useState<InputDraft>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const busy = pending || submitting;
  const link = request.kind === 'url' ? userInputLink(request.url) : null;
  const unsupported = request.kind === 'form' ? request.unsupportedReason : undefined;
  const send = async (response: ChatUserInputResponse) => {
    if (pending || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try { await respond(request.id, response); }
    catch (reason) { setValidationError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setSubmitting(false); }
  };
  const submit = () => {
    if (answerDisabled || busy) return;
    setValidationError(null);
    try { void send(inputResponse(request, draft, notes)); }
    catch (reason) { setValidationError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const onChange = (name: string, value: string | string[]) => setDraft((current) => ({ ...current, [name]: value }));
  const onNotesChange = (name: string, value: string | string[]) => setNotes(current => ({ ...current, [name]: value }));
  const unanswered = request.kind === 'questions' && request.questions.some(question =>
    ![draft[question.id], notes[question.id]].some(value => typeof value === 'string' && value.trim()));
  return <LiquidGlassPanel as="section" className={styles.panel} aria-label="Input requested" data-liquid-glass-backdrop="true">
    <header className={styles.header}>
      <h3 className={styles.heading}><MessageCircleQuestion aria-hidden="true" />
        {request.kind === 'questions' ? korean ? '질문' : 'Question' : `${request.serverName} needs your input`}
      </h3>
      <NeumorphicButton raised size="icon" className={styles.close} disabled={busy}
        aria-label={korean ? '질문 닫기' : 'Close question'} onClick={() => void send({ action: 'cancel' })}><X aria-hidden="true" /></NeumorphicButton>
    </header>
    {otherThread && <p className={styles.message} title={request.threadId}>From another conversation · {request.threadId.slice(0, 8)}…{request.threadId.slice(-4)}</p>}
    <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <fieldset className={styles.question} disabled={busy}>
        <div className={styles.fields}>
          {request.kind === 'questions' && <ChatQuestionFields questions={request.questions} draft={draft} onChange={onChange}
            notes={notes} onNotesChange={onNotesChange} />}
          {request.kind !== 'questions' && <p className={styles.message}>{request.message}</p>}
          {request.kind === 'form' && !unsupported && <ChatMcpFields fields={request.fields} draft={draft} onChange={onChange} />}
          {unsupported && <p className={styles.message}>{unsupported}</p>}
          {request.kind === 'url' && (link
            ? <a className={styles.externalLink} href={link} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />Open {new URL(link).hostname}</a>
            : <p className={styles.message}>This request does not contain a supported web link.</p>)}
        </div>
        {(validationError || error) && <p className={styles.error} role="alert">{validationError || error}</p>}
        <div className={styles.actions}>
          {request.kind !== 'questions' && <NeumorphicButton raised size="standard" type="button" disabled={busy}
            onClick={() => void send({ action: 'cancel' })}>Cancel request</NeumorphicButton>}
          <NeumorphicButton raised size="standard" type="button" disabled={busy} onClick={() => void send({ action: 'decline' })}>
            {request.kind === 'questions' ? korean ? '건너뛰기' : 'Skip' : 'Decline'}
          </NeumorphicButton>
          <NeumorphicButton raised size="standard" type="submit" disabled={busy || answerDisabled || unanswered || Boolean(unsupported) || (request.kind === 'url' && !link)}>
            {busy ? korean ? '전송 중…' : 'Sending…' : request.kind === 'questions' ? korean ? '보내기' : 'Send' : request.kind === 'url' ? 'Done' : 'Submit'}
          </NeumorphicButton>
        </div>
      </fieldset>
    </form>
  </LiquidGlassPanel>;
}

export function ChatUserInputRequests({ contextId, activeThreadId, fallback, fallbackId }: {
  contextId?: string; activeThreadId: string | null; fallback?: ReactNode; fallbackId?: string;
}) {
  const input = useChatUserInputs(contextId);
  const handledFallbacks = useRef(new Set<string>());
  const request = input.requests.find((item) => item.threadId === activeThreadId) ?? input.requests[0];
  if (request?.threadId === activeThreadId && fallbackId) handledFallbacks.current.add(fallbackId);
  if (request) return <ChatUserInputPrompt key={request.id} request={request} respond={input.respond}
    pending={input.loadingId === request.id} error={input.error} otherThread={request.threadId !== activeThreadId} />;
  if (!input.error) return fallbackId && handledFallbacks.current.has(fallbackId) ? null : fallback ?? null;
  return <ChatErrorNotice action={<NeumorphicButton raised size="standard" onClick={input.refresh}>Retry</NeumorphicButton>}>{input.error}</ChatErrorNotice>;
}
