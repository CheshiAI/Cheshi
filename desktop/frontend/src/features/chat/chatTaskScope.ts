export function createChatTaskScope(initialSessionId: string | null) {
  let sessionId = initialSessionId;
  let generation = 0;
  let mounted = true;
  return {
    selectSession(nextSessionId: string | null) {
      if (sessionId === nextSessionId) return;
      sessionId = nextSessionId;
      generation += 1;
    },
    mount() { mounted = true; },
    unmount() {
      mounted = false;
      generation += 1;
    },
    capture() {
      const taskGeneration = generation;
      return () => mounted && taskGeneration === generation;
    },
  };
}
