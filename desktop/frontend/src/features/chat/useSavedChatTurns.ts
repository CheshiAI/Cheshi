import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSavedTurn, ChatSavedTurnInput } from '../../../../shared/chat-saved-turns';
import { errorMessage } from '../../shared/errorMessage';
import { cheshiDesktop } from '../../cheshiDesktop';

const turnKey = (threadId: string, itemId: string) => JSON.stringify([threadId, itemId]);

export function mergeSavedChatTurns(current: ChatSavedTurn[], incoming: ChatSavedTurn[]): ChatSavedTurn[] {
  const records = new Map<string, ChatSavedTurn>();
  for (const record of [...current, ...incoming]) {
    const key = turnKey(record.threadId, record.itemId);
    const existing = records.get(key);
    if (!existing || record.savedAt >= existing.savedAt) records.set(key, record);
  }
  return [...records.values()].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

export function useSavedChatTurns() {
  const [records, setRecords] = useState<ChatSavedTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const saved = useRef<ChatSavedTurn[]>([]);
  const pending = useRef(new Map<string, Promise<boolean>>());
  const mounted = useRef(false);
  const refreshSequence = useRef(0);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deletedIds = useRef(new Set<string>());

  const accept = useCallback((incoming: ChatSavedTurn[]) => {
    saved.current = mergeSavedChatTurns(saved.current, incoming.filter(record => !deletedIds.current.has(record.id)));
    setRecords(saved.current);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (deletingRef.current) return;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    setError(null);
    try {
      if (!cheshiDesktop?.listCodexSavedTurns) throw new Error('Restart Cheshi to load saved turns.');
      const next = await cheshiDesktop.listCodexSavedTurns();
      if (mounted.current && sequence === refreshSequence.current) accept(next);
    } catch (reason) {
      if (mounted.current && sequence === refreshSequence.current) setError(errorMessage(reason));
    } finally {
      if (mounted.current && sequence === refreshSequence.current) setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      refreshSequence.current += 1;
    };
  }, [refresh]);

  const save = useCallback((input: ChatSavedTurnInput): Promise<boolean> => {
    if (deletingRef.current) return Promise.resolve(false);
    const key = turnKey(input.threadId, input.itemId);
    const existing = pending.current.get(key);
    if (existing) return existing;
    if (saved.current.some((record) => turnKey(record.threadId, record.itemId) === key)) return Promise.resolve(true);
    setError(null);
    setSavingKeys((keys) => new Set(keys).add(key));
    const operation = Promise.resolve().then(async () => {
      try {
        if (!cheshiDesktop?.saveCodexTurn) throw new Error('Restart Cheshi to save turns.');
        const record = await cheshiDesktop.saveCodexTurn(input);
        deletedIds.current.delete(record.id);
        if (mounted.current) accept([record]);
        return true;
      } catch (reason) {
        if (mounted.current) setError(errorMessage(reason));
        return false;
      } finally {
        pending.current.delete(key);
        if (mounted.current) setSavingKeys((keys) => {
          const next = new Set(keys);
          next.delete(key);
          return next;
        });
      }
    });
    pending.current.set(key, operation);
    return operation;
  }, [accept]);

  const isSaved = useCallback((threadId: string, itemId: string) => records.some(
    (record) => record.threadId === threadId && record.itemId === itemId,
  ), [records]);
  const isSaving = useCallback((threadId: string, itemId: string) => savingKeys.has(turnKey(threadId, itemId)), [savingKeys]);
  const dismissError = useCallback(() => setError(null), []);
  const remove = useCallback(async (id: string): Promise<boolean> => {
    if (deletingRef.current || pending.current.size > 0) {
      setError('Wait for the current save or deletion to finish.');
      return false;
    }
    const operation = cheshiDesktop?.deleteCodexSavedTurn;
    if (!operation) { setError('Restart Cheshi to delete saved turns.'); return false; }
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      await operation(id);
      deletedIds.current.add(id);
      refreshSequence.current += 1;
      saved.current = saved.current.filter(record => record.id !== id);
      if (mounted.current) { setRecords(saved.current); setLoading(false); setError(null); }
      return true;
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
      return false;
    } finally {
      deletingRef.current = false;
      if (mounted.current) setDeleting(false);
    }
  }, []);
  return useMemo(() => ({ records, loading, error, refresh, save, isSaved, isSaving, dismissError, remove, deleting }),
    [records, loading, error, refresh, save, isSaved, isSaving, dismissError, remove, deleting]);
}

export type SavedChatTurnsController = ReturnType<typeof useSavedChatTurns>;
