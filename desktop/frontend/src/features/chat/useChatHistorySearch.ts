import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatHistorySearchRequest, ChatHistorySearchResponse } from '../../../../shared/chat-history-search';
import { cheshiDesktop } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';

export function useChatHistorySearch(contextId: string) {
  const [result, setResult] = useState<ChatHistorySearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    setResult(null);
    setError(null);
    setLoading(false);
    return () => { mounted.current = false; sequence.current += 1; };
  }, [contextId]);

  const clear = useCallback(() => {
    sequence.current += 1;
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  const search = useCallback(async (request: ChatHistorySearchRequest): Promise<void> => {
    const current = ++sequence.current;
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      if (!cheshiDesktop?.searchCodexChatHistory) throw new Error('Restart Cheshi to search chat history.');
      const response = await cheshiDesktop.searchCodexChatHistory(request, contextId);
      if (mounted.current && sequence.current === current) setResult(response);
    } catch (reason) {
      if (mounted.current && sequence.current === current) setError(errorMessage(reason));
    } finally {
      if (mounted.current && sequence.current === current) setLoading(false);
    }
  }, [contextId]);

  return { result, loading, error, search, clear };
}
