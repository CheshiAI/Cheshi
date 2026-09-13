import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatRelayHistoryRecord, ChatRelayRequest, ChatRelayState } from '../../../../shared/chat-relay';
import { cheshiDesktop } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';

export function useChatRelay() {
  // Live execution state owns reservations; history selection only changes presentation.
  const [state, setState] = useState<ChatRelayState | null>(null);
  const [selectedResult, setSelectedResult] = useState<ChatRelayHistoryRecord | null>(null);
  const [resultVisible, setResultVisible] = useState(true);
  const [history, setHistory] = useState<ChatRelayHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const operationPending = useRef(false);
  const revision = useRef(0);
  const historyRevision = useRef(0);
  const liveId = useRef<string | null>(null);
  const deletedIds = useRef(new Set<string>());
  const deletionPending = useRef(false);
  const [historyDeleting, setHistoryDeleting] = useState(false);
  const selectedResultId = useRef(selectedResult?.id);
  selectedResultId.current = selectedResult?.id;

  const refreshHistory = useCallback(async (): Promise<void> => {
    if (deletionPending.current) return;
    const sequence = ++historyRevision.current;
    setHistoryLoading(true);
    setHistoryError(null);
    const list = cheshiDesktop?.listCodexChatRelayHistory;
    if (!list) {
      setHistoryError('Restart Cheshi to load conversation history.');
      setHistoryLoading(false);
      return;
    }
    try {
      const records = await list();
      if (mounted.current && sequence === historyRevision.current) setHistory(records.filter(record => !deletedIds.current.has(record.id)));
    } catch (reason) {
      if (mounted.current && sequence === historyRevision.current) setHistoryError(errorMessage(reason));
    } finally {
      if (mounted.current && sequence === historyRevision.current) setHistoryLoading(false);
    }
  }, []);

  const acceptState = useCallback((next: ChatRelayState | null) => {
    if (next && deletedIds.current.has(next.id)) return;
    if (next && liveId.current !== next.id) {
      setSelectedResult(null);
      setResultVisible(true);
    }
    liveId.current = next?.id ?? null;
    setState(next);
    if (next && next.status !== 'running' && next.status !== 'stopping') void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const initialRevision = revision.current;
    const unsubscribe = cheshiDesktop?.onCodexChatRelayEvent?.((next) => {
      if (disposed) return;
      revision.current += 1;
      acceptState(next);
    });
    void cheshiDesktop?.getCodexChatRelay?.().then((next) => {
      if (!disposed && revision.current === initialRevision) acceptState(next);
    }).catch((reason: unknown) => {
      if (!disposed) setError(errorMessage(reason));
    });
    void refreshHistory();
    return () => {
      disposed = true;
      mounted.current = false;
      historyRevision.current += 1;
      unsubscribe?.();
    };
  }, [acceptState, refreshHistory]);

  const perform = useCallback(async (operation: () => Promise<ChatRelayState | null>): Promise<boolean> => {
    if (operationPending.current) return false;
    operationPending.current = true;
    const startedAtRevision = revision.current;
    setPending(true);
    setError(null);
    try {
      const next = await operation();
      if (mounted.current && revision.current === startedAtRevision) acceptState(next);
      return true;
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
      return false;
    } finally {
      operationPending.current = false;
      if (mounted.current) setPending(false);
    }
  }, [acceptState]);

  const start = useCallback((request: ChatRelayRequest) => perform(async () => {
    if (!cheshiDesktop?.startCodexChatRelay) throw new Error('Restart Cheshi to load conversation linking.');
    return cheshiDesktop.startCodexChatRelay(request);
  }), [perform]);
  const stop = useCallback(() => perform(async () => {
    if (!cheshiDesktop?.stopCodexChatRelay) throw new Error('Restart Cheshi to load conversation linking.');
    return cheshiDesktop.stopCodexChatRelay();
  }), [perform]);
  const dismissError = useCallback(() => setError(null), []);
  const dismissResult = useCallback(() => setResultVisible(false), []);
  const showResult = useCallback((record: ChatRelayHistoryRecord) => {
    if (deletedIds.current.has(record.id)) return;
    setSelectedResult(record);
    setResultVisible(true);
  }, []);
  const showLiveResult = useCallback(() => {
    setSelectedResult(null);
    setResultVisible(true);
  }, []);
  const displayedState = resultVisible ? selectedResult?.state ?? state : null;

  const deleteHistory = useCallback(async (id: string): Promise<boolean> => {
    if (deletionPending.current) return false;
    const operation = cheshiDesktop?.deleteCodexChatRelayHistory;
    if (!operation) { setHistoryError('Restart Cheshi to delete conversation history.'); return false; }
    deletionPending.current = true;
    setHistoryDeleting(true);
    setHistoryError(null);
    try {
      await operation(id);
      deletedIds.current.add(id);
      historyRevision.current += 1;
      const deletedVisibleResult = selectedResultId.current === id || (!selectedResultId.current && liveId.current === id);
      if (liveId.current === id) { liveId.current = null; revision.current += 1; }
      if (mounted.current) {
        setHistory(records => records.filter(record => record.id !== id));
        setSelectedResult(record => record?.id === id ? null : record);
        setState(current => current?.id === id ? null : current);
        setHistoryLoading(false);
        setHistoryError(null);
        if (deletedVisibleResult) setResultVisible(false);
      }
      return true;
    } catch (reason) {
      if (mounted.current) setHistoryError(errorMessage(reason));
      return false;
    } finally {
      deletionPending.current = false;
      if (mounted.current) setHistoryDeleting(false);
    }
  }, []);

  return {
    state, running: state?.status === 'running' || state?.status === 'stopping', pending, error,
    start, stop, dismissError, dismissResult, displayedState, selectedResult, resultVisible,
    history, historyLoading, historyError, refreshHistory, showResult, showLiveResult, deleteHistory, historyDeleting,
  };
}

export type ChatRelayController = ReturnType<typeof useChatRelay>;
