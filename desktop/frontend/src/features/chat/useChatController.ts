import { completeSkillCatalogWorkflowTurn } from '../../shared/skillCatalogChanges';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { cheshiDesktop as desktopApi } from '../../cheshiDesktop';
import type { CodexChatAttachment } from '../../cheshiDesktop';
import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';
import { continueSavedChatTurn } from './continueSavedChatTurn';
import { observeChatSendAttempt, performChatSend, type ChatSendAttempt } from './chatSendAttempt';
import type { ChatSendResult } from './chatDraftRecovery';
import { CHAT_SESSION_CACHE_TTL_MS, createChatSessionCache, type ChatSessionCache } from './chatSessionCache';
import {
  chatReducer,
  INITIAL_CHAT_STATE,
  isViewedSessionResponding,
  normalizeAgentsResponse,
  normalizeChatEvent,
  normalizeChatCommandStatus,
  normalizeChatConfiguration,
  normalizeGoalResponse,
  normalizeMcpServersResponse,
  normalizeModelsResponse,
  normalizeOpenSessionResponse,
  normalizePermissionModeResponse,
  normalizePermissionModesResponse,
  normalizeSendResponse,
  normalizeSessionsResponse,
  normalizeDeletedSessionsResponse,
  normalizeSkillsResponse,
  type ChatAgentThread,
  type ChatSkill,
  type ChatCommandStatus,
  type ChatConfiguration,
  type ChatGoal,
  type ChatMcpServer,
  type ChatModelCatalog,
  type ChatApprovalDecision,
  type ChatPermissionMode,
  type ChatPermissionModesResponse,
} from './model';

interface UseChatControllerOptions {
  sessionSyncEnabled?: boolean;
  contextId?: string;
  sessionCache?: ChatSessionCache;
}

function operationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSessionNotDeleted(sessionId: string, deletedIds: ReadonlySet<string>): void {
  if (deletedIds.has(sessionId)) throw new Error('This chat has been deleted.');
}

async function requestSessionDeletion(sessionId: string, contextId?: string): Promise<{ threadIds: string[]; warning: string | null }> {
  if (!desktopApi?.deleteCodexChatSession) throw new Error('Restart Cheshi to delete chats.');
  const response: unknown = await desktopApi.deleteCodexChatSession(sessionId, contextId);
  const threadIds = normalizeDeletedSessionsResponse(response, sessionId);
  const warning = response !== null && typeof response === 'object' && 'historySearchWarning' in response
    && typeof response.historySearchWarning === 'string' ? response.historySearchWarning : null;
  return { threadIds, warning };
}

function createClientMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function messageWithAttachments(text: string, attachments: readonly CodexChatAttachment[]): string {
  const fileReferences = attachments
    .filter(({ kind }) => kind === 'file')
    .map(({ path }) => `- ${JSON.stringify(path)}`);
  const parts = [
    text,
    ...(fileReferences.length > 0 ? [`Attached files:\n${fileReferences.join('\n')}`] : []),
    ...attachments.filter(({ kind }) => kind === 'image').map(({ path }) => `[Image: ${path}]`),
  ];
  return parts.join('\n\n');
}

export function useChatController({ sessionSyncEnabled = true, contextId, sessionCache: workspaceSessionCache }: UseChatControllerOptions = {}) {
  const [localSessionCache] = useState(createChatSessionCache);
  const sessionCache = workspaceSessionCache ?? localSessionCache;
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE, initial => {
    const cached = sessionCache.getSnapshot();
    return { ...initial, sessions: cached.sessions, sessionsLoading: cached.loading };
  });
  const [sessionRevision, setSessionRevision] = useState(0);
  const selectionPendingRef = useRef(false);
  const configurationPendingRef = useRef(false);
  const configurationVersionRef = useRef(0);
  const selectionVersionRef = useRef(0);
  const [configurationPending, setConfigurationPending] = useState(false);
  const pendingSendRef = useRef<ChatSendAttempt | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  type NormalizedChatEvent = NonNullable<ReturnType<typeof normalizeChatEvent>>;
  type StreamingDeltaEvent = Extract<NormalizedChatEvent, { type: 'assistant-delta' | 'reasoning-delta' | 'plan-delta' | 'plan-completed' }>;
  const pendingDeltasRef = useRef(new Map<string, StreamingDeltaEvent>());
  const deltaFrameRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const deletedSessionIdsRef = useRef(new Set(sessionCache.deletedIds));
  const applyDeletedSessions = useCallback((threadIds: string[]) => {
    sessionCache.remove(threadIds);
    const newlyDeleted = threadIds.filter(id => !deletedSessionIdsRef.current.has(id));
    for (const id of threadIds) deletedSessionIdsRef.current.add(id);
    if (!mountedRef.current || newlyDeleted.length === 0) return;
    if (stateRef.current.activeSessionId && newlyDeleted.includes(stateRef.current.activeSessionId)) {
      selectionVersionRef.current += 1;
      configurationVersionRef.current += 1;
      setSessionRevision(revision => revision + 1);
    }
    dispatch({ type: 'event', event: { type: 'sessions-deleted', threadIds } });
  }, [sessionCache]);

  const refreshSessions = useCallback((force = true): Promise<void> => sessionCache.refresh(async () => {
    if (!desktopApi?.listCodexChatSessions) throw new Error('The Codex chat API is unavailable.');
    // The workspace service survives disposal of the pane that requested the list.
    return normalizeSessionsResponse(await desktopApi.listCodexChatSessions());
  }, force), [sessionCache]);

  useEffect(() => {
    const syncSessions = () => {
      const cached = sessionCache.getSnapshot();
      if (!cached.loading) dispatch({ type: 'sessions-loaded', sessions: cached.sessions });
      if (cached.error) dispatch({ type: 'sessions-error', message: cached.error });
    };
    const unsubscribe = sessionCache.subscribe(syncSessions);
    syncSessions();
    return unsubscribe;
  }, [sessionCache]);

  useEffect(() => {
    mountedRef.current = true;
    const takePendingDeltas = (): StreamingDeltaEvent[] => {
      const deltas = [...pendingDeltasRef.current.values()];
      pendingDeltasRef.current.clear();
      return deltas;
    };
    const flushPendingDeltas = (): void => {
      deltaFrameRef.current = null;
      const deltas = takePendingDeltas();
      if (deltas.length > 0) dispatch({ type: 'events', events: deltas });
    };
    const queueDelta = (event: StreamingDeltaEvent): void => {
      const key = `${event.threadId}:${event.type}:${event.itemId}`;
      const pending = pendingDeltasRef.current.get(key);
      pendingDeltasRef.current.set(key, pending
        ? { ...pending, text: `${pending.text}${event.text}` }
        : event);
      if (deltaFrameRef.current === null) {
        deltaFrameRef.current = window.requestAnimationFrame(flushPendingDeltas);
      }
    };
    const removeListener = desktopApi?.onCodexChatEvent?.((value) => {
      observeChatSendAttempt(pendingSendRef.current, value);
      const event = normalizeChatEvent(value);
      if (!event) return;
      sessionCache.observe(event);
      if (event.type === 'turn-completed') completeSkillCatalogWorkflowTurn(event.threadId);
      if (event.type === 'sessions-deleted') {
        applyDeletedSessions(event.threadIds);
        return;
      }
      if (('threadId' in event && event.threadId && deletedSessionIdsRef.current.has(event.threadId))
        || (event.type === 'session-created' && deletedSessionIdsRef.current.has(event.session.id))) return;
      if (event.type === 'permission-mode-changed') configurationVersionRef.current += 1;
      if (event.type === 'assistant-delta' || event.type === 'reasoning-delta' || event.type === 'plan-delta') {
        queueDelta(event);
        return;
      }
      if (deltaFrameRef.current !== null) {
        window.cancelAnimationFrame(deltaFrameRef.current);
        deltaFrameRef.current = null;
      }
      const deltas = takePendingDeltas();
      dispatch(deltas.length > 0
        ? { type: 'events', events: [...deltas, event] }
        : { type: 'event', event });
      if (event.type === 'sessions-changed') void refreshSessions();
    }, contextId);
    return () => {
      mountedRef.current = false;
      if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
      pendingDeltasRef.current.clear();
      removeListener?.();
    };
  }, [contextId, refreshSessions, applyDeletedSessions, sessionCache]);

  useEffect(() => {
    if (!sessionSyncEnabled) return;

    const refreshVisibleSessions = (): void => {
      if (document.visibilityState === 'visible') void refreshSessions();
    };
    window.addEventListener('focus', refreshVisibleSessions);
    document.addEventListener('visibilitychange', refreshVisibleSessions);
    const intervalId = window.setInterval(refreshVisibleSessions, CHAT_SESSION_CACHE_TTL_MS);
    // Initial history must load while the workspace is hidden behind the splash.
    void refreshSessions(false);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshVisibleSessions);
      document.removeEventListener('visibilitychange', refreshVisibleSessions);
    };
  }, [refreshSessions, sessionSyncEnabled]);

  const openSession = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!desktopApi?.openCodexChatSession || selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current) return false;
    selectionPendingRef.current = true;
    selectionVersionRef.current += 1;
    dispatch({ type: 'opening-session' });
    try {
      const opened = normalizeOpenSessionResponse(await desktopApi.openCodexChatSession(sessionId, contextId));
      if (!mountedRef.current) return false;
      assertSessionNotDeleted(opened.session.id, deletedSessionIdsRef.current);
      dispatch({ type: 'session-opened', ...opened });
      setSessionRevision((revision) => revision + 1);
      return true;
    } catch (error) {
      if (mountedRef.current) dispatch({ type: 'opening-session-failed', message: operationMessage(error) });
      return false;
    } finally {
      selectionPendingRef.current = false;
    }
  }, [contextId]);

  const openAgent = useCallback(async (agentThreadId: string): Promise<void> => {
    if (!desktopApi?.openCodexChatAgent) throw new Error('The Codex agent API is unavailable.');
    if (selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current) return;
    selectionPendingRef.current = true;
    selectionVersionRef.current += 1;
    try {
      const opened = normalizeOpenSessionResponse(await desktopApi.openCodexChatAgent(agentThreadId, contextId));
      if (!mountedRef.current) return;
      assertSessionNotDeleted(opened.session.id, deletedSessionIdsRef.current);
      dispatch({ type: 'session-opened', ...opened });
      setSessionRevision((revision) => revision + 1);
    } finally {
      selectionPendingRef.current = false;
    }
  }, [contextId]);

  const newSession = useCallback(async (): Promise<void> => {
    if (!desktopApi?.newCodexChatSession || selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current) return;
    selectionPendingRef.current = true;
    selectionVersionRef.current += 1;
    dispatch({ type: 'opening-session' });
    try {
      await desktopApi.newCodexChatSession(contextId);
      if (!mountedRef.current) return;
      dispatch({ type: 'new-session' });
      setSessionRevision((revision) => revision + 1);
    } catch (error) {
      if (mountedRef.current) dispatch({ type: 'opening-session-failed', message: operationMessage(error) });
    } finally {
      selectionPendingRef.current = false;
    }
  }, [contextId]);

  const continueSavedTurn = useCallback(async (record: ChatSavedTurn): Promise<boolean> => {
    const api = desktopApi;
    if (!api?.newCodexChatSession || !api.sendCodexChatMessage
      || selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current || state.phase === 'loading' || isViewedSessionResponding(state)) return false;
    selectionPendingRef.current = true;
    selectionVersionRef.current += 1;
    dispatch({ type: 'opening-session' });
    let sessionReady = false;
    const attempt: ChatSendAttempt = { clientMessageId: createClientMessageId(), threadId: null, accepted: false };
    pendingSendRef.current = attempt;
    try {
      const result = await performChatSend(attempt, () => continueSavedChatTurn(api, record, contextId, attempt.clientMessageId, (text) => {
        if (!mountedRef.current) return false;
        sessionReady = true;
        dispatch({ type: 'new-session' });
        setSessionRevision((revision) => revision + 1);
        dispatch({ type: 'optimistic-user', id: `client:${attempt.clientMessageId}`, text,
          title: record.sessionTitle || 'Saved conversation', createdAt: Math.floor(Date.now() / 1000) });
        return true;
      }));
      if (!mountedRef.current) return false;
      if (result.status === 'accepted') return true;
      const message = result.status === 'unknown' && sessionReady
        ? `Delivery could not be confirmed. Check this conversation before sending again. ${result.message ?? ''}`
        : result.message ?? 'The conversation could not be started.';
      dispatch(sessionReady
        ? { type: 'send-failed', clientMessageId: attempt.clientMessageId, threadId: attempt.threadId, message, uncertain: result.status === 'unknown' }
        : { type: 'opening-session-failed', message });
      return false;
    } finally {
      if (pendingSendRef.current === attempt) pendingSendRef.current = null;
      selectionPendingRef.current = false;
    }
  }, [contextId, state]);

  const listSkills = useCallback(async (): Promise<ChatSkill[]> => {
    if (!desktopApi?.listCodexSkills) throw new Error('The Codex skills API is unavailable.');
    return normalizeSkillsResponse(await desktopApi.listCodexSkills(contextId));
  }, [contextId]);

  const listAgents = useCallback(async (): Promise<ChatAgentThread[]> => {
    if (!desktopApi?.listCodexChatAgents) throw new Error('The Codex agent API is unavailable.');
    return normalizeAgentsResponse(await desktopApi.listCodexChatAgents(contextId));
  }, [contextId]);

  const listModels = useCallback(async (): Promise<ChatModelCatalog> => {
    if (!desktopApi?.listCodexModels) throw new Error('The Codex model API is unavailable.');
    return normalizeModelsResponse(await desktopApi.listCodexModels(contextId));
  }, [contextId]);

  const listMcpServers = useCallback(async (): Promise<ChatMcpServer[]> => {
    if (!desktopApi?.listCodexMcpServers) throw new Error('The Codex MCP server API is unavailable.');
    return normalizeMcpServersResponse(await desktopApi.listCodexMcpServers(contextId));
  }, [contextId]);

  const listPermissionModes = useCallback(async (): Promise<ChatPermissionModesResponse> => {
    if (!desktopApi?.listCodexPermissionModes) throw new Error('The Codex permissions API is unavailable.');
    const selectionVersion = selectionVersionRef.current;
    const configurationVersion = configurationVersionRef.current;
    const threadId = stateRef.current.activeSessionId;
    const response = normalizePermissionModesResponse(await desktopApi.listCodexPermissionModes(contextId));
    if (mountedRef.current && selectionVersion === selectionVersionRef.current
      && configurationVersion === configurationVersionRef.current && threadId === stateRef.current.activeSessionId) {
      dispatch({ type: 'event', event: { type: 'permission-mode-changed', mode: response.currentMode } });
    }
    return response;
  }, [contextId]);

  const mutateConfiguration = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (!mountedRef.current || configurationPendingRef.current || selectionPendingRef.current || pendingSendRef.current
      || stateRef.current.phase === 'loading' || isViewedSessionResponding(stateRef.current)) {
      throw new Error('Wait for the current operation to finish before changing chat settings.');
    }
    configurationPendingRef.current = true;
    configurationVersionRef.current += 1;
    setConfigurationPending(true);
    try { return await operation(); }
    finally {
      configurationPendingRef.current = false;
      configurationVersionRef.current += 1;
      if (mountedRef.current) setConfigurationPending(false);
    }
  }, []);

  const setPermissionMode = useCallback(async (modeId: string): Promise<ChatPermissionMode> => {
    const api = desktopApi;
    if (!api?.setCodexPermissionMode) throw new Error('The Codex permissions API is unavailable.');
    return mutateConfiguration(async () => {
      const response = normalizePermissionModeResponse(await api.setCodexPermissionMode(modeId, contextId));
      if (mountedRef.current) dispatch({ type: 'event', event: { type: 'permission-mode-changed', mode: response.mode } });
      return response.mode;
    });
  }, [contextId, mutateConfiguration]);

  const setCollaborationMode = useCallback(async (mode: 'default' | 'plan'): Promise<ChatConfiguration> => {
    const api = desktopApi;
    if (!api?.setCodexChatCollaborationMode) throw new Error('The Codex collaboration mode API is unavailable.');
    return mutateConfiguration(async () => normalizeChatConfiguration(await api.setCodexChatCollaborationMode(mode, contextId)));
  }, [contextId, mutateConfiguration]);

  const respondToApproval = useCallback(async (
    approvalId: string,
    decision: ChatApprovalDecision,
  ): Promise<void> => {
    if (!desktopApi?.respondCodexChatApproval) throw new Error('The Codex approval API is unavailable.');
    await desktopApi.respondCodexChatApproval(approvalId, decision, contextId);
  }, [contextId]);

  const configureChat = useCallback(async (options: { model?: string; effort?: string; fast?: boolean }): Promise<ChatConfiguration> => {
    const api = desktopApi;
    if (!api?.configureCodexChat) throw new Error('The Codex configuration API is unavailable.');
    return mutateConfiguration(async () => normalizeChatConfiguration(await api.configureCodexChat(options, contextId)));
  }, [contextId, mutateConfiguration]);

  const getChatStatus = useCallback(async (): Promise<ChatCommandStatus> => {
    if (!desktopApi?.getCodexChatStatus) throw new Error('The Codex status API is unavailable.');
    return normalizeChatCommandStatus(await desktopApi.getCodexChatStatus(contextId));
  }, [contextId]);

  const getGoal = useCallback(async (): Promise<ChatGoal | null> => {
    if (!desktopApi?.getCodexChatGoal) throw new Error('The Codex goal API is unavailable.');
    return normalizeGoalResponse(await desktopApi.getCodexChatGoal(contextId)).goal;
  }, [contextId]);

  const setGoal = useCallback(async (objective: string): Promise<ChatGoal> => {
    const api = desktopApi;
    if (!api?.setCodexChatGoal) throw new Error('The Codex goal API is unavailable.');
    return mutateConfiguration(async () => {
      const response = normalizeGoalResponse(await api.setCodexChatGoal(objective, contextId));
      if (!response.goal) throw new Error('Codex did not return the persistent goal.');
      if (mountedRef.current) dispatch({ type: 'event', event: { type: 'session-selected', threadId: response.goal.threadId } });
      return response.goal;
    });
  }, [contextId, mutateConfiguration]);

  const forkSession = useCallback(async (): Promise<boolean> => {
    if (!desktopApi?.forkCodexChatSession || selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current) return false;
    selectionPendingRef.current = true;
    selectionVersionRef.current += 1;
    dispatch({ type: 'opening-session' });
    try {
      const opened = normalizeOpenSessionResponse(await desktopApi.forkCodexChatSession(contextId));
      if (!mountedRef.current) return false;
      setSessionRevision((revision) => revision + 1);
      dispatch({ type: 'session-opened', ...opened });
      return true;
    } catch (error) {
      dispatch({ type: 'opening-session-failed', message: operationMessage(error) });
      return false;
    } finally {
      selectionPendingRef.current = false;
    }
  }, [contextId]);

  const compactSession = useCallback(async (): Promise<boolean> => {
    if (!desktopApi?.compactCodexChatSession || selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current
      || stateRef.current.phase === 'loading' || isViewedSessionResponding(stateRef.current)) return false;
    selectionPendingRef.current = true;
    try {
      const response = normalizeSendResponse(await desktopApi.compactCodexChatSession(contextId));
      dispatch({ type: 'event', event: { type: 'session-selected', threadId: response.threadId } });
      return true;
    } catch (error) {
      dispatch({ type: 'message-error', message: operationMessage(error) });
      return false;
    } finally {
      selectionPendingRef.current = false;
    }
  }, [contextId]);

  const reviewSession = useCallback(async (): Promise<boolean> => {
    if (!desktopApi?.reviewCodexChatSession || selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current
      || stateRef.current.phase === 'loading' || isViewedSessionResponding(stateRef.current)) return false;
    selectionPendingRef.current = true;
    try {
      const response = normalizeSendResponse(await desktopApi.reviewCodexChatSession(contextId));
      dispatch({ type: 'event', event: { type: 'session-selected', threadId: response.threadId } });
      return true;
    } catch (error) {
      dispatch({ type: 'message-error', message: operationMessage(error) });
      return false;
    } finally {
      selectionPendingRef.current = false;
    }
  }, [contextId]);

  const sendMessage = useCallback(async (
    text: string,
    selectedSkill: ChatSkill | null = null,
    attachments: readonly CodexChatAttachment[] = [],
  ): Promise<ChatSendResult> => {
    const api = desktopApi;
    if (!api?.sendCodexChatMessage) return { status: 'failed', message: 'The Codex chat API is unavailable.' };
    const current = stateRef.current;
    if (!mountedRef.current || selectionPendingRef.current || configurationPendingRef.current || pendingSendRef.current
      || current.phase === 'loading' || current.pendingNewResponse) {
      return { status: 'blocked', message: 'Wait for the current operation to finish before sending.' };
    }
    const steering = isViewedSessionResponding(current);
    const submit = steering ? api.steerCodexChatMessage : api.sendCodexChatMessage;
    if (!submit) return { status: 'failed', message: 'The Codex steering API is unavailable.' };
    const value = text.trim();
    if (!value) return { status: 'blocked' };
    const attempt: ChatSendAttempt = { clientMessageId: createClientMessageId(), threadId: current.activeSessionId, accepted: false };
    pendingSendRef.current = attempt;
    dispatch({ type: 'optimistic-user', id: `client:${attempt.clientMessageId}`,
      text: [...(selectedSkill ? [`$${selectedSkill.name}`] : []), messageWithAttachments(value, attachments)].join('\n\n'),
      title: value, createdAt: Math.floor(Date.now() / 1000) });
    try {
      const result = await performChatSend(attempt, () => submit(
        value, attempt.clientMessageId, selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path } : null,
        attachments, current.activeSessionId, contextId));
      if (result.status !== 'accepted' && mountedRef.current) {
        dispatch({ type: 'send-failed', clientMessageId: attempt.clientMessageId, threadId: attempt.threadId,
          message: result.message ?? 'The message was not sent.', uncertain: result.status === 'unknown', steering });
      }
      if (result.status === 'accepted' && mountedRef.current) dispatch({ type: 'send-accepted', clientMessageId: attempt.clientMessageId });
      return result;
    } finally {
      if (pendingSendRef.current === attempt) pendingSendRef.current = null;
    }
  }, [contextId]);

  const cancelResponse = useCallback(async (): Promise<void> => {
    if (!desktopApi?.cancelCodexChatResponse) return;
    const targetThreadId = state.activeSessionId;
    try {
      await desktopApi.cancelCodexChatResponse(targetThreadId, contextId);
    } catch (error) {
      dispatch({ type: 'operation-error', message: operationMessage(error) });
    }
  }, [contextId, state.activeSessionId]);

  const isOperationPending = useCallback(() => selectionPendingRef.current
    || configurationPendingRef.current || pendingSendRef.current !== null, []);
  const deleteSession = useCallback(async (sessionId: string): Promise<boolean> => {
    if (isOperationPending()) return false;
    selectionPendingRef.current = true;
    try {
      const result = await requestSessionDeletion(sessionId, contextId);
      applyDeletedSessions(result.threadIds);
      if (result.warning && mountedRef.current) dispatch({ type: 'operation-error', message: result.warning });
      return true;
    } catch (error) {
      if (mountedRef.current) dispatch({ type: 'operation-error', message: operationMessage(error) });
      return false;
    } finally {
      selectionPendingRef.current = false;
    }
  }, [contextId, isOperationPending, applyDeletedSessions]);

  const dismissError = useCallback(() => dispatch({ type: 'dismiss-error' }), []);

  return useMemo(() => ({
    state,
    contextId,
    sessionRevision,
    configurationPending,
    permissionPending: configurationPending,
    openSession,
    openAgent,
    newSession,
    deleteSession,
    isOperationPending,
    continueSavedTurn,
    sendMessage,
    listAgents,
    listSkills,
    listModels,
    listMcpServers,
    listPermissionModes,
    setPermissionMode,
    setCollaborationMode,
    respondToApproval,
    configureChat,
    getChatStatus,
    getGoal,
    setGoal,
    forkSession,
    compactSession,
    reviewSession,
    cancelResponse,
    dismissError,
    refreshSessions,
  }), [state, contextId, sessionRevision, configurationPending, openSession, openAgent, newSession, deleteSession, isOperationPending, continueSavedTurn, sendMessage, listAgents, listSkills,
    listModels, listMcpServers, listPermissionModes, setPermissionMode, setCollaborationMode, respondToApproval,
    configureChat, getChatStatus, getGoal, setGoal, forkSession, compactSession,
    reviewSession, cancelResponse, dismissError, refreshSessions]);
}

export type ChatController = ReturnType<typeof useChatController>;
