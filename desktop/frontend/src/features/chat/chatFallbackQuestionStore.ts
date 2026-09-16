import type { ChatUserInputResponse } from '../../../../shared/chat-user-input';
import type { ChatSendResult } from './chatDraftRecovery';
import type { ChatQuestionDismissalsApi, ChatQuestionDismissal } from '../../../../shared/chat-question-dismissals';
import type { FallbackQuestionRequest } from './chatQuestionChoices';

interface QuestionState { request: FallbackQuestionRequest | null; pending: boolean; error: string | null; uncertain: boolean; restoreError: string | null; resolution: ChatQuestionDismissal | null }
const empty = (): QuestionState => ({ request: null, pending: false, error: null, uncertain: false, restoreError: null, resolution: null });

function questionAnswerText(request: FallbackQuestionRequest, response: ChatUserInputResponse): string | null {
  if (request.kind !== 'questions' || !request.questions.length) return null;
  const answers = response.answers;
  if (!answers || Object.keys(answers).some(id => !request.questions.some(question => question.id === id))) return null;
  const parts: string[] = [];
  for (const question of request.questions) {
    const values = answers[question.id];
    if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())) return null;
    parts.push(request.delivery !== 'async' && request.questions.length === 1 ? values.join('\n\n') : `${question.question}\n${values.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

export function createFallbackQuestionStore(send: (text: string, threadId: string, request: FallbackQuestionRequest) => Promise<ChatSendResult>, persistence?: ChatQuestionDismissalsApi) {
  let state = empty();
  let context = { threadId: null as string | null, blocked: true, request: null as FallbackQuestionRequest | null };
  let active = true;
  let revision = 0;
  let restored = !persistence;
  const dismissed = new Map<string, ChatQuestionDismissal>();
  const sending = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (next: QuestionState) => { state = next; listeners.forEach(listener => listener()); };
  const select = () => {
    if (!restored) return;
    const request = context.request;
    const resolution = request ? dismissed.get(request.id)
      ?? (request.legacyQuestionId ? dismissed.get(request.legacyQuestionId) : undefined) ?? null : null;
    const next = request && !resolution ? request : null;
    if (state.request?.threadId === context.threadId && (state.pending || state.error) && (!next || next.id === state.request.id)) return;
    if (state.request?.id !== next?.id || state.resolution !== resolution) publish({ ...empty(), request: next, resolution });
  };
  const restore = async () => {
    const threadId = context.threadId;
    if (!persistence || !threadId || !active) return;
    const current = ++revision;
    restored = false;
    publish(empty());
    try {
      const records = await persistence.list(threadId);
      if (!active || current !== revision) return;
      records.forEach(record => dismissed.set(record.questionId, record));
      restored = true;
      select();
    } catch {
      if (active && current === revision) publish({ ...empty(), restoreError: 'Could not restore dismissed questions. Retry to load this conversation’s question card.' });
    }
  };
  const remember = async (request: FallbackQuestionRequest, action: ChatQuestionDismissal['action'], answers?: Record<string, string[]>) => {
    const record: ChatQuestionDismissal = { questionId: request.id, action,
      ...(request.sourceItemId ? { turnId: request.turnId, itemId: request.sourceItemId } : {}),
      ...(action === 'answered' && request.delivery === 'async' && answers ? { answers } : {}) };
    if (persistence) await persistence.save(request.threadId, record);
    if (active && context.threadId === request.threadId) dismissed.set(request.id, record);
    return record;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setActive(value: boolean) {
      active = value;
      if (!value) { revision++; dismissed.clear(); restored = !persistence; context = { threadId: null, blocked: true, request: null }; state = empty(); }
    },
    retryRestore: restore,
    sync(threadId: string | null, request: FallbackQuestionRequest | null, blocked: boolean) {
      if (!active) return;
      const changed = context.threadId !== threadId;
      context = { threadId, blocked, request };
      if (changed) {
        revision++;
        dismissed.clear();
        restored = !persistence;
        publish(empty());
        if (persistence) { void restore(); return; }
      }
      select();
    },
    async respond(id: string, response: ChatUserInputResponse): Promise<boolean> {
      const request = state.request;
      if (!active || !request || request.id !== id || request.threadId !== context.threadId || state.pending || sending.has(id)) return false;
      if (response.action !== 'accept') {
        sending.add(id);
        publish({ ...state, pending: true, error: null });
        try {
          const resolution = await remember(request, response.action === 'decline' ? 'skip' : 'close');
          if (active && state.request?.id === id) publish({ ...empty(), resolution });
          return true;
        } catch {
          if (active && state.request?.id === id) publish({ ...state, pending: false, error: 'Could not save the dismissed question. Please try Skip or Close again.' });
          return false;
        } finally { sending.delete(id); }
      }
      if (context.blocked || state.uncertain) return false;
      const text = questionAnswerText(request, response);
      if (!text) return false;
      sending.add(id);
      publish({ ...state, pending: true, error: null });
      let result: ChatSendResult;
      try { result = await send(text, request.threadId, request); }
      catch { result = { status: 'unknown' }; }
      let resolution: ChatQuestionDismissal | null = null;
      if (result.status === 'accepted') {
        try { resolution = await remember(request, 'answered', response.answers); }
        catch {
          sending.delete(id);
          if (active && state.request?.id === id) publish({ ...state, pending: false, uncertain: true,
            error: 'The answer was sent, but its completion could not be saved. Use Close to retry saving without sending again.' });
          return false;
        }
      }
      sending.delete(id);
      if (state.request?.id !== id) return false;
      if (result.status === 'accepted') { publish({ ...empty(), resolution }); return true; }
      publish({ ...state, pending: false, uncertain: result.status === 'unknown', error: result.status === 'unknown'
        ? 'Delivery is unconfirmed. Check the conversation before sending this answer again.'
        : result.message ?? 'The answer was not sent. Please try again.' });
      return false;
    },
  };
}
