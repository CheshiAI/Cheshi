import { useEffect, useRef } from 'react';

import { createChatTaskScope } from './chatTaskScope';

export function useChatTaskScope(sessionId: string | null) {
  const scopeRef = useRef<ReturnType<typeof createChatTaskScope> | null>(null);
  if (!scopeRef.current) scopeRef.current = createChatTaskScope(sessionId);
  const scope = scopeRef.current;
  scope.selectSession(sessionId);
  useEffect(() => {
    scope.mount();
    return () => scope.unmount();
  }, [scope]);
  return scope.capture;
}
