import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { ChatFallbackQuestion, createMessageQuestionStore } from './ChatFallbackQuestion';
import { asyncQuestionRequest } from './chatQuestionChoices';
import type { ChatTimelineItem } from './model';
import type { ChatController } from './useChatController';
import type { ChatViewController } from './useChatViewController';
import type { ChatQuestionDismissalsApi } from '../../../../shared/chat-question-dismissals';

type QuestionEnvironment = {
  controller: ChatViewController; chatController: ChatController; active: boolean;
  persistence?: ChatQuestionDismissalsApi;
};
type QuestionStore = ReturnType<typeof createMessageQuestionStore>;
const ChatQuestionContext = createContext<(QuestionEnvironment & { storeFor(id: string): QuestionStore }) | null>(null);

/** Keep pending sends and unconfirmed results when history rows unmount or the user switches threads. */
export function ChatQuestionProvider({ children, ...environment }: QuestionEnvironment & { children: ReactNode }) {
  const latest = useRef(environment);
  latest.current = environment;
  const stores = useRef(new Map<string, QuestionStore>());
  const storeFor = useCallback((id: string) => {
    const key = JSON.stringify([latest.current.chatController.contextId, id]);
    let store = stores.current.get(key);
    if (!store) {
      store = createMessageQuestionStore(() => latest.current.chatController, latest.current.persistence);
      stores.current.set(key, store);
    }
    return store;
  }, []);
  const { controller, chatController, active, persistence } = environment;
  const value = useMemo(() => ({ controller, chatController, active, persistence, storeFor }),
    [controller, chatController, active, persistence, storeFor]);
  return <ChatQuestionContext.Provider value={value}>{children}</ChatQuestionContext.Provider>;
}

export function ChatInlineQuestion({ item }: { item: ChatTimelineItem }) {
  const context = useContext(ChatQuestionContext);
  const threadId = context?.controller.state.activeSessionId ?? null;
  const candidate = useMemo(() => asyncQuestionRequest(item, threadId), [item, threadId]);
  if (!context || !candidate) return null;
  return <ChatFallbackQuestion {...context} candidate={candidate} retainedStore={context.storeFor(candidate.id)} inline />;
}
