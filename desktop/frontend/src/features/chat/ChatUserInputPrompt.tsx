import { ExternalLink, MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';
import type { ChatUserInputRequest, ChatUserInputResponse } from '../../../../shared/chat-user-input';
import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import { ChatMcpFields, ChatQuestionFields } from './ChatUserInputFields';
import { initialInputDraft, inputResponse, userInputLink } from './chatUserInputForm';
import { useChatUserInputs } from './useChatUserInputs';
import styles from './ChatUserInputPrompt.module.css';
import { ChatErrorNotice } from './ChatErrorNotice';

export function ChatUserInputPrompt({ request, respond, pending, error, otherThread = false }: {
  request: ChatUserInputRequest;
  respond: (id: string, response: ChatUserInputResponse) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  otherThread?: boolean;
}) {
  const [draft, setDraft] = useState(() => initialInputDraft(request));
  const [validationError, setValidationError] = useState<string | null>(null);
  const link = request.kind === 'url' ? userInputLink(request.url) : null;
  const unsupported = request.kind === 'form' ? request.unsupportedReason : undefined;
  const submit = () => {
    setValidationError(null);
    try { void respond(request.id, inputResponse(request, draft)); }
    catch (reason) { setValidationError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const onChange = (name: string, value: string | string[]) => setDraft((current) => ({ ...current, [name]: value }));
  return <LiquidGlassPanel as="section" className={styles.panel} aria-label="Input requested"
    data-liquid-glass-surface="side-panel" data-liquid-glass-backdrop="true">
    <h3 className={styles.heading}><MessageCircleQuestion aria-hidden="true" />
      {request.kind === 'questions' ? 'Codex has a question' : `${request.serverName} needs your input`}
    </h3>
    {otherThread && <p className={styles.message} title={request.threadId}>From another conversation · {request.threadId.slice(0, 8)}…{request.threadId.slice(-4)}</p>}
    <form onSubmit={(event) => { event.preventDefault(); if (!pending) submit(); }}>
      <fieldset className={styles.question} disabled={pending}>
        <div className={styles.fields}>
          {request.kind === 'questions' && <ChatQuestionFields questions={request.questions} draft={draft} onChange={onChange} />}
          {request.kind !== 'questions' && <p className={styles.message}>{request.message}</p>}
          {request.kind === 'form' && !unsupported && <ChatMcpFields fields={request.fields} draft={draft} onChange={onChange} />}
          {unsupported && <p className={styles.message}>{unsupported}</p>}
          {request.kind === 'url' && (link
            ? <a className={styles.externalLink} href={link} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />Open {new URL(link).hostname}</a>
            : <p className={styles.message}>This request does not contain a supported web link.</p>)}
        </div>
        {(validationError || error) && <p className={styles.error} role="alert">{validationError || error}</p>}
        <div className={styles.actions}>
          <NeumorphicButton raised size="standard" type="button" disabled={pending} onClick={() => void respond(request.id, { action: 'cancel' })}>Cancel request</NeumorphicButton>
          <NeumorphicButton raised size="standard" type="button" disabled={pending} onClick={() => void respond(request.id, { action: 'decline' })}>
            {request.kind === 'questions' ? 'Skip' : 'Decline'}
          </NeumorphicButton>
          <NeumorphicButton raised size="standard" type="submit" disabled={pending || Boolean(unsupported) || (request.kind === 'url' && !link)}>
            {pending ? 'Sending…' : request.kind === 'questions' ? 'Submit answers' : request.kind === 'url' ? 'Done' : 'Submit'}
          </NeumorphicButton>
        </div>
      </fieldset>
    </form>
  </LiquidGlassPanel>;
}

export function ChatUserInputRequests({ contextId, activeThreadId }: { contextId?: string; activeThreadId: string | null }) {
  const input = useChatUserInputs(contextId);
  const request = input.requests.find((item) => item.threadId === activeThreadId) ?? input.requests[0];
  if (request) return <ChatUserInputPrompt key={request.id} request={request} respond={input.respond}
    pending={input.loadingId === request.id} error={input.error} otherThread={request.threadId !== activeThreadId} />;
  if (!input.error) return null;
  return <ChatErrorNotice action={<NeumorphicButton raised size="standard" onClick={input.refresh}>Retry</NeumorphicButton>}>{input.error}</ChatErrorNotice>;
}
