import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatHistorySearchRequest, type ChatHistorySearchRequest, type ChatHistorySearchResponse } from '../../../../shared/chat-history-search';
import { cheshiDesktop } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import { normalizeChatEvent } from './model';

const RESULT_CACHE_TTL_MS = 300_000;
const RESULT_CACHE_LIMIT = 50;
interface CachedSearch { response: ChatHistorySearchResponse; storedAt: number }
interface PendingSearch { promise: Promise<ChatHistorySearchResponse>; refresh: boolean }

export function useChatHistorySearch(contextId: string, workspaceContextIds?: readonly string[]) {
  const [result, setResult] = useState<ChatHistorySearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const scope = useRef(contextId);
  const revision = useRef(0);
  const cache = useRef(new Map<string, CachedSearch>());
  const pending = useRef(new Map<string, PendingSearch>());
  const observedContexts = useMemo(() => [...new Set([contextId, ...(workspaceContextIds ?? [])])], [contextId, workspaceContextIds]);

  const invalidateCache = useCallback(() => {
    revision.current += 1;
    cache.current.clear();
    pending.current.clear();
  }, []);

  const clear = useCallback(() => {
    sequence.current += 1;
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  const reset = useCallback(() => {
    invalidateCache();
    clear();
  }, [clear, invalidateCache]);

  useEffect(() => {
    mounted.current = true;
    scope.current = contextId;
    reset();
    return () => {
      mounted.current = false;
      sequence.current += 1;
      invalidateCache();
    };
  }, [contextId, reset, invalidateCache]);

  useEffect(() => {
    const unsubscribe = observedContexts.map(id => cheshiDesktop?.onCodexChatEvent?.(value => {
      const event = normalizeChatEvent(value);
      if (!event) return;
      switch (event.type) {
        case 'session-selected':
        case 'permission-mode-changed':
        case 'approval-requested':
        case 'approval-resolved':
        case 'error': return;
        case 'sessions-deleted': reset(); return;
        default: invalidateCache();
      }
    }, id));
    return () => { unsubscribe.forEach(remove => remove?.()); };
  }, [observedContexts, reset, invalidateCache]);

  const search = useCallback(async (request: ChatHistorySearchRequest): Promise<void> => {
    if (!mounted.current || scope.current !== contextId) return;
    const current = ++sequence.current;
    setError(null);
    try {
      const normalized = chatHistorySearchRequest(request);
      const key = JSON.stringify([normalized.query.normalize('NFC').toLowerCase().split(/\s+/u).filter(Boolean),
        normalized.filePath, normalized.limit]);
      let task = pending.current.get(key);
      if (normalized.refresh && !task?.refresh) {
        invalidateCache();
        task = undefined;
      }
      const now = Date.now();
      for (const [cachedKey, entry] of cache.current) {
        if (now < entry.storedAt || now - entry.storedAt >= RESULT_CACHE_TTL_MS) cache.current.delete(cachedKey);
      }
      const cached = cache.current.get(key);
      if (!normalized.refresh && cached) {
        cache.current.delete(key);
        cache.current.set(key, cached);
        setResult(cached.response);
        setLoading(false);
        return;
      }
      setResult(null);
      setLoading(true);
      if (!cheshiDesktop?.searchCodexChatHistory) throw new Error('Restart Cheshi to search chat history.');
      if (!task) {
        const requestRevision = revision.current;
        const entry: PendingSearch = {
          refresh: normalized.refresh,
          promise: cheshiDesktop.searchCodexChatHistory(request, contextId),
        };
        entry.promise = entry.promise.then(response => {
          // Display an already requested snapshot, but never cache it across a history change.
          if (mounted.current && revision.current === requestRevision && response.unavailableSessions.length === 0) {
            cache.current.delete(key);
            cache.current.set(key, { response, storedAt: Date.now() });
            if (cache.current.size > RESULT_CACHE_LIMIT) {
              const oldest = cache.current.keys().next().value;
              if (oldest !== undefined) cache.current.delete(oldest);
            }
          }
          return response;
        }).finally(() => {
          if (pending.current.get(key) === entry) pending.current.delete(key);
        });
        pending.current.set(key, entry);
        task = entry;
      }
      const response = await task.promise;
      if (mounted.current && sequence.current === current) setResult(response);
    } catch (reason) {
      if (mounted.current && sequence.current === current) {
        setResult(null);
        setError(errorMessage(reason));
      }
    } finally {
      if (mounted.current && sequence.current === current) setLoading(false);
    }
  }, [contextId, invalidateCache]);

  return { result, loading, error, search, clear, reset };
}
