import { useCallback, useEffect, useRef, useState } from 'react';
import { chatUserInputRequest, inputRecord, type ChatUserInputRequest, type ChatUserInputResponse } from '../../../../shared/chat-user-input';
import { cheshiDesktop } from '../../cheshiDesktop';

export function useChatUserInputs(contextId?: string) {
  const [requests, setRequests] = useState<ChatUserInputRequest[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pending = useRef(new Set<string>());
  const current = useRef(requests);
  current.current = requests;

  useEffect(() => {
    const epoch = ++generation.current;
    let active = true;
    const changed = new Set<string>();
    setRequests([]);
    setError(null);
    setLoadingId(null);
    if (!cheshiDesktop?.listCodexChatUserInputs || !cheshiDesktop.respondCodexChatUserInput) {
      if (cheshiDesktop) setError('Restart Cheshi to enable answers to pending questions.');
      return () => { active = false; generation.current += 1; };
    }
    const dispose = cheshiDesktop.onCodexChatEvent((value) => {
      if (!active) return;
      const event = inputRecord(value);
      if (event?.type === 'user-input-requested') {
        const request = chatUserInputRequest(event.request);
        if (!request) return;
        changed.add(request.id);
        setRequests((items) => [...items.filter((item) => item.id !== request.id), request]);
      } else if (event?.type === 'user-input-resolved' && typeof event.requestId === 'string') {
        const id = event.requestId;
        changed.add(id);
        setRequests((items) => items.filter((item) => item.id !== id));
        setError(null);
      }
    }, contextId);
    void cheshiDesktop.listCodexChatUserInputs(contextId).then((items) => {
      if (!active || generation.current !== epoch) return;
      const initial = items.map(chatUserInputRequest).filter((item): item is ChatUserInputRequest => item !== null && !changed.has(item.id));
      setRequests((live) => [...initial, ...live]);
    }).catch(() => {
      if (active) setError('Could not load pending questions. Retry to check for requests.');
    });
    return () => { active = false; generation.current += 1; dispose?.(); };
  }, [contextId, revision]);

  const respond = useCallback(async (requestId: string, response: ChatUserInputResponse): Promise<boolean> => {
    if (!cheshiDesktop || pending.current.has(requestId) || !current.current.some((item) => item.id === requestId)) return false;
    const epoch = generation.current;
    pending.current.add(requestId);
    setLoadingId(requestId);
    setError(null);
    try {
      await cheshiDesktop.respondCodexChatUserInput(requestId, response, contextId);
      if (generation.current === epoch) setRequests((items) => items.filter((item) => item.id !== requestId));
      return true;
    } catch (reason) {
      if (generation.current === epoch && current.current.some((item) => item.id === requestId)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      return false;
    } finally {
      pending.current.delete(requestId);
      if (generation.current === epoch) setLoadingId(null);
    }
  }, [contextId]);
  return { requests, respond, loadingId, error, refresh: () => setRevision((value) => value + 1) };
}
