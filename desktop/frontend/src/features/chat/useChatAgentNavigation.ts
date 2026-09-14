import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/errorMessage';
import type { ChatAgentThread } from './model';

interface ChatAgentNavigationOptions {
  activeSessionId: string | null;
  isKnownMainSession?: boolean;
  listAgents: () => Promise<ChatAgentThread[]>;
  openAgent: (threadId: string) => Promise<void>;
  isOperationPending: () => boolean;
}

export function useChatAgentNavigation({
  activeSessionId, isKnownMainSession = false, listAgents, openAgent, isOperationPending,
}: ChatAgentNavigationOptions) {
  const [target, setTarget] = useState<{ sourceId: string; mainId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  const returningRef = useRef(false);
  const generationRef = useRef(0);
  const knownMainSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    setTarget(null);
    setError(null);
    setReturning(false);
    returningRef.current = false;
    if (knownMainSessionIdRef.current !== activeSessionId) knownMainSessionIdRef.current = null;
    if (isKnownMainSession) knownMainSessionIdRef.current = activeSessionId;
    // Newly created main threads can precede their persisted account history.
    // They need no return target, even if a stale catalog refresh omits them.
    if (activeSessionId && knownMainSessionIdRef.current !== activeSessionId) {
      void listAgents().then((agents) => {
        if (generation !== generationRef.current) return;
        const current = agents.find((agent) => agent.id === activeSessionId);
        const main = agents.find((agent) => agent.kind === 'main');
        if (current?.kind === 'subagent' && main && main.id !== activeSessionId) {
          setTarget({ sourceId: activeSessionId, mainId: main.id });
        }
      }).catch((reason: unknown) => {
        if (generation === generationRef.current) setError(errorMessage(reason));
      });
    }
    return () => { generationRef.current += 1; };
  }, [activeSessionId, isKnownMainSession, listAgents]);

  const mainThreadId = target?.sourceId === activeSessionId ? target.mainId : null;
  const returnToMain = useCallback(async (): Promise<void> => {
    if (!mainThreadId || returningRef.current || isOperationPending()) return;
    const generation = generationRef.current;
    returningRef.current = true;
    setReturning(true);
    setError(null);
    try {
      await openAgent(mainThreadId);
    } catch (reason) {
      if (generation === generationRef.current) setError(errorMessage(reason));
    } finally {
      if (generation === generationRef.current) {
        returningRef.current = false;
        setReturning(false);
      }
    }
  }, [isOperationPending, mainThreadId, openAgent]);

  const dismissError = useCallback(() => setError(null), []);
  return { mainThreadId, returning, error, dismissError, returnToMain };
}
