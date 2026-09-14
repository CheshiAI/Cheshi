import type { ChatAction, ChatActivityItem, ChatPhase, ChatSession, ChatState, ChatTimelineItem } from './model';

function upsertTextItem(
  items: ChatTimelineItem[],
  id: string,
  kind: 'assistant' | 'reasoning' | 'plan',
  delta: string,
  createdAt: number,
  replace = false,
): ChatTimelineItem[] {
  const index = items.findIndex((item) => item.id === id && item.kind === kind);
  if (index < 0) return [...items, { id, kind, text: delta, createdAt }];
  return items.map((item, itemIndex) => (
    itemIndex === index && item.kind !== 'activity'
      ? { ...item, text: replace ? delta : `${item.text}${delta}` }
      : item
  ));
}

function upsertUserMessage(
  items: ChatTimelineItem[],
  message: { clientMessageId: string; text: string; createdAt: number },
): ChatTimelineItem[] {
  const id = `client:${message.clientMessageId}`;
  const existing = items.find((item) => item.id === id && item.kind === 'user');
  if (existing?.kind === 'user' && existing.text === message.text
    && existing.createdAt === message.createdAt && existing.pending === false && !existing.delivery) return items;
  const providerItemId = existing?.kind === 'user' ? existing.providerItemId : undefined;
  const item = { id, kind: 'user' as const, text: message.text, createdAt: message.createdAt, pending: false,
    ...(providerItemId ? { providerItemId } : {}) };
  return existing
    ? items.map((candidate) => candidate === existing ? item : candidate)
    : [...items, item];
}

function upsertActivity(items: ChatTimelineItem[], activity: ChatActivityItem): ChatTimelineItem[] {
  const index = items.findIndex((item) => item.id === activity.id && item.kind === 'activity');
  if (index < 0) return [...items, activity];
  return items.map((item, itemIndex) => {
    if (itemIndex !== index) return item;
    if (item.kind === 'activity' && item.activity === 'command' && activity.activity === 'command') {
      return { ...item, ...activity };
    }
    return activity;
  });
}

function replaceSession(sessions: ChatSession[], session: ChatSession): ChatSession[] {
  return [session, ...sessions.filter((candidate) => candidate.id !== session.id)];
}

function addResponseThread(responseThreadIds: string[], threadId: string): string[] {
  return responseThreadIds.includes(threadId) ? responseThreadIds : [...responseThreadIds, threadId];
}

function removeResponseThread(responseThreadIds: string[], threadId: string): string[] {
  return responseThreadIds.filter((candidate) => candidate !== threadId);
}

function responsePhase(
  currentPhase: ChatPhase,
  responseThreadIds: string[],
  pendingNewResponse: boolean,
): ChatPhase {
  if (currentPhase === 'loading') return 'loading';
  return responseThreadIds.length > 0 || pendingNewResponse ? 'streaming' : 'idle';
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'operation-error') return { ...state, error: action.message };
  if (action.type === 'events') {
    return action.events.reduce(
      (currentState, event) => chatReducer(currentState, { type: 'event', event }),
      state,
    );
  }
  if (action.type === 'sessions-loaded') {
    return { ...state, sessions: action.sessions, sessionsLoading: false };
  }
  if (action.type === 'sessions-error') {
    return { ...state, sessionsLoading: false, error: action.message };
  }
  if (action.type === 'opening-session') {
    return { ...state, phase: 'loading', error: null };
  }
  if (action.type === 'opening-session-failed') {
    return {
      ...state,
      phase: responsePhase('idle', state.responseThreadIds, state.pendingNewResponse),
      error: action.message,
    };
  }
  if (action.type === 'session-opened') {
    return {
      ...state,
      activeSessionId: action.session.id,
      responseThreadIds: action.responseThreadIds,
      pendingNewResponse: false,
      activeTitle: action.session.title,
      items: action.items,
      permissionMode: null,
      phase: action.responseInProgress ? 'streaming' : 'idle',
      error: null,
    };
  }
  if (action.type === 'new-session') {
    return {
      ...state,
      activeSessionId: null,
      pendingNewResponse: false,
      activeTitle: 'New chat',
      items: [],
      phase: responsePhase('idle', state.responseThreadIds, false),
      error: null,
      access: 'Read only',
      permissionMode: null,
    };
  }
  if (action.type === 'optimistic-user') {
    const responseThreadIds = state.activeSessionId
      ? addResponseThread(state.responseThreadIds, state.activeSessionId)
      : state.responseThreadIds;
    return {
      ...state,
      activeTitle: state.activeSessionId ? state.activeTitle : action.title.slice(0, 60),
      items: [...state.items, { id: action.id, kind: 'user', text: action.text, createdAt: action.createdAt, pending: true }],
      phase: 'streaming',
      responseThreadIds,
      pendingNewResponse: state.activeSessionId === null,
      error: null,
    };
  }
  if (action.type === 'send-accepted') {
    return { ...state, items: state.items.map((item) => {
      if (item.kind !== 'user' || item.id !== `client:${action.clientMessageId}`) return item;
      const { delivery: _delivery, ...accepted } = item;
      return { ...accepted, pending: false };
    }) };
  }
  if (action.type === 'send-failed') {
    const id = `client:${action.clientMessageId}`;
    const messageIndex = state.items.findIndex((item) => item.kind === 'user' && item.id === id);
    if (messageIndex < 0) return state;
    const items = state.items.map((item) => item.kind === 'user' && item.id === id
      ? { ...item, pending: false, delivery: action.uncertain ? 'unknown' as const : 'failed' as const } : item);
    if (action.steering) return { ...state, items, error: action.message };
    if (state.items.slice(messageIndex + 1).some((item) => item.kind === 'user')) return { ...state, items };
    const responseThreadIds = state.activeSessionId
      ? removeResponseThread(state.responseThreadIds, state.activeSessionId) : state.responseThreadIds;
    return {
      ...state,
      items,
      responseThreadIds,
      pendingNewResponse: false,
      phase: responsePhase(state.phase, responseThreadIds, false),
      error: action.message,
    };
  }
  if (action.type === 'message-error') {
    const hasTarget = Object.hasOwn(action, 'threadId');
    const responseThreadIds = typeof action.threadId === 'string'
      ? removeResponseThread(state.responseThreadIds, action.threadId)
      : state.responseThreadIds;
    const pendingNewResponse = action.threadId === null ? false : state.pendingNewResponse;
    const affectsViewedSession = !hasTarget || action.threadId === state.activeSessionId;
    return {
      ...state,
      items: affectsViewedSession
        ? state.items.map((item) => item.kind === 'user' && item.pending ? { ...item, pending: false } : item)
        : state.items,
      phase: responsePhase(state.phase, responseThreadIds, pendingNewResponse),
      responseThreadIds,
      pendingNewResponse,
      error: affectsViewedSession ? action.message : state.error,
      approvals: typeof action.threadId === 'string'
        ? state.approvals.filter((approval) => approval.threadId !== action.threadId)
        : state.approvals,
    };
  }
  if (action.type === 'dismiss-error') return { ...state, error: null };

  const event = action.event;
  if (event.type === 'sessions-deleted') {
    const deleted = new Set(event.threadIds);
    const next = {
      ...state,
      sessions: state.sessions.filter(session => !deleted.has(session.id)),
      responseThreadIds: state.responseThreadIds.filter(id => !deleted.has(id)),
      approvals: state.approvals.filter(approval => !deleted.has(approval.threadId)),
    };
    return state.activeSessionId && deleted.has(state.activeSessionId)
      ? chatReducer(next, { type: 'new-session' }) : next;
  }
  if (event.type === 'session-created') {
    return { ...state, sessions: replaceSession(state.sessions, event.session) };
  }
  if (event.type === 'session-selected') {
    const remappedResponses = state.responseThreadIds.map(id => id === event.previousThreadId ? event.threadId : id);
    const responseThreadIds = state.pendingNewResponse
      ? addResponseThread(remappedResponses, event.threadId)
      : remappedResponses;
    return {
      ...state,
      activeSessionId: event.threadId,
      responseThreadIds,
      pendingNewResponse: false,
      phase: responsePhase(state.phase, responseThreadIds, false),
    };
  }
  if (event.type === 'session-title') {
    return {
      ...state,
      activeTitle: state.activeSessionId === event.threadId ? event.title : state.activeTitle,
      sessions: state.sessions.map((session) => (
        session.id === event.threadId ? { ...session, title: event.title } : session
      )),
    };
  }
  if (event.type === 'turn-started') {
    const responseThreadIds = addResponseThread(state.responseThreadIds, event.threadId);
    const selectsPendingSession = state.activeSessionId === null && state.pendingNewResponse;
    return {
      ...state,
      activeSessionId: selectsPendingSession ? event.threadId : state.activeSessionId,
      phase: state.phase === 'loading' ? 'loading' : 'streaming',
      responseThreadIds,
      pendingNewResponse: selectsPendingSession ? false : state.pendingNewResponse,
    };
  }
  if (event.type === 'user-message-identified') {
    if (event.threadId !== state.activeSessionId) return state;
    const id = `client:${event.clientMessageId}`;
    const existing = state.items.find(item => item.kind === 'user' && item.id === id);
    if (!existing || existing.kind !== 'user' || existing.providerItemId) return state;
    if (state.items.some(item => item.id === event.itemId
      || (item.kind === 'user' && item.providerItemId === event.itemId))) return state;
    return { ...state, items: state.items.map(item => item === existing
      ? { ...existing, providerItemId: event.itemId } : item) };
  }
  if (event.type === 'user-message') {
    if (event.threadId !== state.activeSessionId) return state;
    const items = upsertUserMessage(state.items, event);
    return items === state.items ? state : { ...state, items };
  }
  if (event.type === 'assistant-delta' || event.type === 'reasoning-delta' || event.type === 'plan-delta' || event.type === 'plan-completed') {
    if (event.threadId !== state.activeSessionId) return state;
    return {
      ...state,
      items: upsertTextItem(
        state.items,
        event.itemId,
        event.type === 'assistant-delta' ? 'assistant' : event.type === 'reasoning-delta' ? 'reasoning' : 'plan',
        event.text,
        event.createdAt,
        event.type === 'plan-completed',
      ),
    };
  }
  if (event.type === 'assistant-questions') {
    if (event.threadId !== state.activeSessionId) return state;
    const items = upsertTextItem(state.items, event.itemId, 'assistant', '', event.createdAt);
    return {
      ...state,
      items: items.map(item => item.id === event.itemId && item.kind === 'assistant'
        ? { ...item, questions: event.questions } : item),
    };
  }
  if (event.type === 'command-output-delta') {
    if (event.threadId !== state.activeSessionId) return state;
    const existing = state.items.find((item) => item.kind === 'activity' && item.id === event.itemId);
    if (existing && (existing.kind !== 'activity' || existing.activity !== 'command' || existing.status !== 'inProgress')) return state;
    const command: ChatActivityItem = existing?.kind === 'activity' ? existing
      : { id: event.itemId, kind: 'activity', activity: 'command', label: 'Command', detail: '', status: 'inProgress' };
    return { ...state, items: upsertActivity(state.items, { ...command, output: `${command.output ?? ''}${event.text}` }) };
  }
  if (event.type === 'activity') {
    return event.threadId === state.activeSessionId
      ? { ...state, items: upsertActivity(state.items, event.item) }
      : state;
  }
  if (event.type === 'permission-mode-changed') {
    return { ...state, access: event.mode.access, permissionMode: event.mode };
  }
  if (event.type === 'approval-requested') {
    return {
      ...state,
      approvals: [
        ...state.approvals.filter((approval) => approval.id !== event.approval.id),
        event.approval,
      ],
    };
  }
  if (event.type === 'approval-resolved') {
    return {
      ...state,
      approvals: state.approvals.filter((approval) => approval.id !== event.approvalId),
    };
  }
  if (event.type === 'turn-completed') {
    const failed = event.status === 'failed';
    const unfinishedStatus = failed || event.status === 'interrupted' ? event.status : null;
    const responseThreadIds = removeResponseThread(state.responseThreadIds, event.threadId);
    const affectsViewedSession = event.threadId === state.activeSessionId;
    return {
      ...state,
      items: affectsViewedSession
        ? state.items.map((item) => {
          if (item.kind === 'user' && item.pending) return { ...item, pending: false };
          if (item.kind === 'activity' && item.status === 'inProgress' && unfinishedStatus) {
            return { ...item, status: unfinishedStatus };
          }
          return item;
        })
        : state.items,
      phase: responsePhase(state.phase, responseThreadIds, state.pendingNewResponse),
      responseThreadIds,
      error: affectsViewedSession && failed
        ? event.message ?? 'Codex could not complete the response.'
        : state.error,
      approvals: state.approvals.filter((approval) => approval.threadId !== event.threadId),
    };
  }
  if (event.type === 'error') {
    const responseThreadIds = event.threadId
      ? removeResponseThread(state.responseThreadIds, event.threadId)
      : state.responseThreadIds;
    const pendingNewResponse = event.threadId === null ? false : state.pendingNewResponse;
    const affectsViewedSession = event.threadId === null || event.threadId === state.activeSessionId;
    return {
      ...state,
      items: affectsViewedSession
        ? state.items.map((item) => item.kind === 'user' && item.pending ? { ...item, pending: false } : item)
        : state.items,
      phase: responsePhase(state.phase, responseThreadIds, pendingNewResponse),
      responseThreadIds,
      pendingNewResponse,
      error: affectsViewedSession ? event.message : state.error,
      approvals: event.threadId
        ? state.approvals.filter((approval) => approval.threadId !== event.threadId)
        : state.approvals,
    };
  }
  return state;
}
