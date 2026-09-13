import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { chatRelayContextIds } from '../../../../shared/chat-relay';
import { cheshiDesktop } from '../../cheshiDesktop';
import { splitPaneIds, type SplitPaneDirection } from '../../shared/ui/splitPaneModel';
import { closeChatPane, createChatWorkspace, resizeChatPane, splitChatPane } from './chatWorkspaceModel';
import type { ChatController } from './useChatController';
import { useChatRelay } from './useChatRelay';
import { prepareChatFork } from './prepareChatSplit';
import { chatForkUnavailableReason, chatHistoryForkUnavailableReason } from './chatWorkspaceModel';
import { openChatHistoryFork } from './openChatHistoryFork';
import { useSavedChatTurns } from './useSavedChatTurns';
import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';
import { isViewedSessionResponding } from './model';
import { chatSessionDeletionReason } from './chatSessionDeletion';
import { createChatSessionCache } from './chatSessionCache';
import { chatAccountSwitchReason } from './chatAccountSwitch';
import { updateResumeCoordinator } from '../shell/updateWorkspaceResume';
import { parseChatUpdateSnapshot, reopenUpdateConversations, type ChatUpdateSnapshot } from './chatUpdateResume';

export function useChatWorkspace() {
  const [sessionCache, setSessionCache] = useState(createChatSessionCache);
  const sessionHistory = useSyncExternalStore(sessionCache.subscribe, sessionCache.getSnapshot);
  const relay = useChatRelay();
  const savedTurns = useSavedChatTurns();
  const [state, setState] = useState(() => createChatWorkspace(crypto.randomUUID()));
  const [controllers, setControllers] = useState<Record<string, ChatController>>({});
  const [error, setError] = useState<string | null>(null);
  const [accountSwitchPending, setAccountSwitchPending] = useState(false);
  const accountSwitchRef = useRef(false);
  const composerGuards = useRef(new Map<string, () => string | null>());
  const [composerRevision, setComposerRevision] = useState(0);
  const registerAccountSwitchGuard = useCallback((paneId: string, guard: (() => string | null) | null) => {
    if (guard) composerGuards.current.set(paneId, guard);
    else composerGuards.current.delete(paneId);
    setComposerRevision((revision) => revision + 1);
  }, []);
  const [initialSessionIds, setInitialSessionIds] = useState<Record<string, string>>({});
  const [splitPending, setSplitPending] = useState(false);
  const splitPendingRef = useRef(false);
  const [deletePending, setDeletePending] = useState(false);
  const deletePendingRef = useRef(false);
  const mountedRef = useRef(true);
  const currentStateRef = useRef(state);
  currentStateRef.current = state;
  const latestRef = useRef({ controllers, relay });
  latestRef.current = { controllers, relay };
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const paneIds = useMemo(() => splitPaneIds(state.layout), [state.layout]);
  const updateRecovery = useRef<{
    snapshot: ChatUpdateSnapshot; started: boolean; resolve(): void; reject(reason: Error): void;
  } | null>(null);
  useEffect(() => {
    const pending = updateRecovery.current;
    if (!pending || pending.started || !splitPaneIds(pending.snapshot.layout).every((id) => controllers[id])) return;
    pending.started = true;
    void reopenUpdateConversations(pending.snapshot, controllers).then(pending.resolve, (reason: unknown) => pending.reject(reason instanceof Error ? reason : new Error(String(reason))));
  }, [controllers, state.layout]);
  useEffect(() => () => updateRecovery.current?.reject(new Error('Workspace recovery was interrupted.')), []);
  const getAccountSwitchReason = useCallback(() => {
    const current = latestRef.current;
    const ids = splitPaneIds(currentStateRef.current.layout);
    return chatAccountSwitchReason({
      pending: accountSwitchRef.current || splitPendingRef.current || deletePendingRef.current
        || current.relay.pending || current.relay.historyDeleting,
      relayRunning: current.relay.running,
      paneCount: ids.length,
      controllers: ids.flatMap((id) => current.controllers[id] ? [current.controllers[id]!] : []),
      composerReasons: ids.flatMap((id) => composerGuards.current.has(id) ? [composerGuards.current.get(id)!()] : []),
    });
  }, []);
  useEffect(() => updateResumeCoordinator.register('chat', {
    capture() {
      const reason = getAccountSwitchReason();
      if (reason) throw new Error(reason.replace('switching accounts', 'updating'));
      const current = currentStateRef.current;
      const sessionIds = Object.fromEntries(splitPaneIds(current.layout).flatMap((id) => {
        const session = latestRef.current.controllers[id]?.state.activeSessionId;
        return session ? [[id, session]] : [];
      }));
      return { ...current, sessionIds };
    },
    restore(value) {
      const snapshot = parseChatUpdateSnapshot(value);
      const restored = { layout: snapshot.layout, activePaneId: snapshot.activePaneId };
      currentStateRef.current = restored;
      // Reopen explicitly so failed thread restoration retains the durable checkpoint.
      // initialSessionIds belongs to fork creation and opens threads without awaiting them.
      setInitialSessionIds({});
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          updateRecovery.current = null;
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error('Saved conversations could not be reopened in time.')), 15_000);
        updateRecovery.current = { snapshot, started: false, resolve: () => finish(), reject: finish };
        setState(restored);
      });
    },
  }), [getAccountSwitchReason]);
  const accountSwitchReason = useMemo(() => getAccountSwitchReason(),
    [getAccountSwitchReason, controllers, paneIds, relay, splitPending, deletePending, accountSwitchPending, composerRevision]);
  const beginAccountSwitch = useCallback(() => {
    const reason = getAccountSwitchReason();
    if (reason) return reason;
    accountSwitchRef.current = true;
    setAccountSwitchPending(true);
    return null;
  }, [getAccountSwitchReason]);
  const completeAccountSwitch = useCallback((changed: boolean, preserveConversation = false) => {
    if (changed && !preserveConversation) {
      const previousIds = splitPaneIds(currentStateRef.current.layout);
      const next = createChatWorkspace(crypto.randomUUID());
      currentStateRef.current = next;
      setSessionCache(createChatSessionCache());
      setState(next);
      setControllers({});
      setInitialSessionIds({});
      setError(null);
      composerGuards.current.clear();
      for (const id of previousIds) void cheshiDesktop?.disposeCodexChatContext(id).catch((reason: unknown) => {
        if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
      });
    }
    accountSwitchRef.current = false;
    setAccountSwitchPending(false);
  }, []);
  const registerController = useCallback((paneId: string, controller: ChatController | null) => {
    setControllers((current) => {
      if (current[paneId] === controller) return current;
      const next = { ...current };
      if (controller) next[paneId] = controller;
      else delete next[paneId];
      return next;
    });
  }, []);
  const selectPane = useCallback((paneId: string) => {
    if (deletePendingRef.current) return;
    setState((current) => current.activePaneId === paneId || !splitPaneIds(current.layout).includes(paneId)
      ? current : { ...current, activePaneId: paneId });
  }, []);
  const splitPane = useCallback(async (targetId: string, direction: SplitPaneDirection, mode: 'new' | 'fork' = 'new', sourceThreadId?: string): Promise<boolean> => {
    if (splitPendingRef.current || deletePendingRef.current) return false;
    const ids = splitPaneIds(currentStateRef.current.layout);
    if (!ids.includes(targetId) || ids.length >= 32) return false;
    const paneId = crypto.randomUUID();
    const splitId = crypto.randomUUID();
    if (mode === 'new') {
      setState((current) => splitChatPane(current, targetId, paneId, direction, splitId));
      return true;
    }
    const source = controllers[targetId]?.state;
    const locked = relay.running && relay.state !== null && chatRelayContextIds(relay.state).includes(targetId);
    const unavailable = chatForkUnavailableReason(source, locked);
    if (unavailable || !sourceThreadId || source?.activeSessionId !== sourceThreadId) {
      setError(unavailable ?? 'The source conversation changed. Reopen the split dialog.');
      return false;
    }
    if (!cheshiDesktop) { setError('The chat API is unavailable.'); return false; }
    splitPendingRef.current = true;
    setSplitPending(true);
    setError(null);
    try {
      const sessionId = await prepareChatFork(cheshiDesktop, sourceThreadId, paneId);
      const currentIds = splitPaneIds(currentStateRef.current.layout);
      if (!mountedRef.current || !currentIds.includes(targetId) || currentIds.length >= 32) {
        await cheshiDesktop.disposeCodexChatContext(paneId);
        return false;
      }
      setInitialSessionIds((current) => ({ ...current, [paneId]: sessionId }));
      setState((current) => splitChatPane(current, targetId, paneId, direction, splitId));
      return true;
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      splitPendingRef.current = false;
      if (mountedRef.current) setSplitPending(false);
    }
  }, [controllers, relay.running, relay.state]);
  const closePane = useCallback((paneId: string) => {
    if (deletePendingRef.current) return;
    const replacementId = crypto.randomUUID();
    setState((current) => closeChatPane(current, paneId, replacementId));
    setInitialSessionIds((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    void cheshiDesktop?.disposeCodexChatContext(paneId).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);
  const resizeSplit = useCallback((splitId: string, ratio: number) => {
    setState((current) => resizeChatPane(current, splitId, ratio));
  }, []);
  const dismissError = useCallback(() => setError(null), []);
  const activeController = controllers[state.activePaneId] ?? null;
  const responseThreadIds = [...new Set(paneIds.flatMap((id) => controllers[id]?.state.responseThreadIds ?? []))];
  const openSession = useCallback(async (sessionId: string): Promise<boolean> => {
    if (deletePendingRef.current) return false;
    const existingPane = paneIds.find((id) => controllers[id]?.state.activeSessionId === sessionId || controllers[id]?.state.responseThreadIds.includes(sessionId));
    if (existingPane) {
      selectPane(existingPane);
      if (controllers[existingPane]?.state.activeSessionId !== sessionId) {
        return await controllers[existingPane]?.openSession(sessionId) ?? false;
      }
      return true;
    }
    return await activeController?.openSession(sessionId) ?? false;
  }, [activeController, controllers, paneIds, selectPane]);

  const deleteSessionReason = useCallback((sessionId: string): string | null => {
    const current = latestRef.current;
    const active = current.controllers[currentStateRef.current.activePaneId];
    return chatSessionDeletionReason(sessionId, Boolean(active), splitPendingRef.current || deletePendingRef.current,
      current.relay.running, Object.values(current.controllers));
  }, []);
  const deleteSession = useCallback(async (sessionId: string): Promise<boolean> => {
    const reason = deleteSessionReason(sessionId);
    if (reason) { setError(reason); return false; }
    const controller = latestRef.current.controllers[currentStateRef.current.activePaneId];
    if (!controller) return false;
    deletePendingRef.current = true;
    setDeletePending(true);
    setError(null);
    try {
      return await controller.deleteSession(sessionId);
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      deletePendingRef.current = false;
      if (mountedRef.current) setDeletePending(false);
    }
  }, [deleteSessionReason]);

  const historyForkReason = useCallback((sessionId: string, targetId: string): string | null => {
    if (deletePendingRef.current) return 'Wait for the conversation deletion to finish.';
    const current = latestRef.current;
    const target = current.controllers[targetId]?.state;
    const relayState = current.relay.state;
    const locked = current.relay.running && relayState !== null
      && (chatRelayContextIds(relayState).includes(targetId)
        || [relayState.sourceThreadId, relayState.targetThreadId, relayState.moderatorThreadId].includes(sessionId));
    const sourceResponding = Object.values(current.controllers).some((controller) =>
      controller.state.responseThreadIds.includes(sessionId)
      || controller.state.sessions.some((session) => session.id === sessionId && session.status === 'active'));
    return chatHistoryForkUnavailableReason(target, locked, sourceResponding);
  }, []);

  const forkHistorySession = useCallback(async (sessionId: string, targetId: string): Promise<boolean> => {
    if (splitPendingRef.current || deletePendingRef.current) return false;
    const unavailable = historyForkReason(sessionId, targetId);
    if (unavailable) { setError(unavailable); return false; }
    if (!cheshiDesktop) { setError('The chat API is unavailable.'); return false; }
    const previousSessionId = latestRef.current.controllers[targetId]?.state.activeSessionId;
    splitPendingRef.current = true;
    setSplitPending(true);
    setError(null);
    try {
      return await openChatHistoryFork(cheshiDesktop, sessionId, crypto.randomUUID(), async (forkId) => {
        if (!mountedRef.current) return false;
        const target = latestRef.current.controllers[targetId];
        if (!target || target.state.activeSessionId !== previousSessionId || historyForkReason(sessionId, targetId)) {
          setError('The destination pane changed or is busy. Reopen the fork from chat history.');
          return false;
        }
        const opened = await target.openSession(forkId);
        if (opened) selectPane(targetId);
        else setError('The fork was created but could not be opened. Select it from chat history to retry.');
        return opened;
      });
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      splitPendingRef.current = false;
      if (mountedRef.current) setSplitPending(false);
    }
  }, [historyForkReason, selectPane]);

  const savedTurnContinuationReason = !activeController ? 'Wait for the chat pane to be ready.'
    : activeController.state.phase === 'loading' || isViewedSessionResponding(activeController.state) || splitPending || deletePending
      ? 'Wait for the current operation to finish.'
      : relay.running && relay.state !== null && chatRelayContextIds(relay.state).includes(state.activePaneId)
        ? 'Wait for the linked conversation to finish.' : null;
  const continueSavedTurn = async (record: ChatSavedTurn): Promise<boolean> => {
    if (deletePendingRef.current || savedTurnContinuationReason || !activeController) return false;
    return activeController.continueSavedTurn(record);
  };

  return {
    ...state, paneIds, controllers, activeController, responseThreadIds, sessionCache, sessionHistory,
    registerController, selectPane, splitPane, closePane, resizeSplit, openSession,
    error, dismissError, relay, initialSessionIds, splitPending, historyForkReason, forkHistorySession, savedTurns,
    continueSavedTurn, savedTurnContinuationReason, deleteSession, deleteSessionReason, deletePending,
    registerAccountSwitchGuard, accountSwitchPending, accountSwitchReason, beginAccountSwitch, completeAccountSwitch,
  };
}

export type ChatWorkspaceController = ReturnType<typeof useChatWorkspace>;
