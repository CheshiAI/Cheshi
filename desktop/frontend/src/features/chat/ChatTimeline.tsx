import { ArrowDown, Sparkles } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { LoadingState, NeumorphicButton } from '../../shared/ui';
import { ChatTimelineHistory } from './ChatTimelineHistory';
import { ChatErrorNotice } from './ChatErrorNotice';
import { ChatWelcome } from './ChatWelcome';
import styles from './ChatView.module.css';
import type { ChatViewController } from './useChatViewController';
import { completedChatTurnInputs } from './chatTurnSnapshots';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import type { ChatHistorySearchNavigation } from './chatHistorySearchNavigation';

interface ChatTimelineProps extends ChatHistorySearchNavigation {
  controller: Pick<ChatViewController, 'loading' | 'pauseAutoScroll' | 'scrollToBottom' | 'showScrollToBottom'
    | 'state' | 'streaming' | 'timelineRef' | 'workspaceName'> & Partial<Pick<ChatViewController, 'scrollToHistoryItem'>>;
  onReviewFileChanges: (itemId: string, path?: string) => void;
  savedTurns?: SavedChatTurnsController;
}

export function ChatTimeline({ controller, onReviewFileChanges, savedTurns, historyTarget, onHistoryTargetHandled }: ChatTimelineProps) {
  const {
    loading,
    pauseAutoScroll,
    scrollToBottom,
    showScrollToBottom,
    state,
    streaming,
    timelineRef,
    workspaceName,
  } = controller;
  const completedTurns = useMemo(() => completedChatTurnInputs(state.items, state.activeSessionId, state.activeTitle, streaming),
    [state.items, state.activeSessionId, state.activeTitle, streaming]);
  const [missingHistoryThread, setMissingHistoryThread] = useState<string | null>(null);
  const handleHistoryTarget = useCallback((requestId: number, found: boolean) => {
    setMissingHistoryThread(found ? null : state.activeSessionId);
    onHistoryTargetHandled?.(requestId, found);
  }, [onHistoryTargetHandled, state.activeSessionId]);

  return (
    <>
      {missingHistoryThread && missingHistoryThread === state.activeSessionId && <ChatErrorNotice
        onDismiss={() => setMissingHistoryThread(null)}>
        The original message is no longer available in this conversation. Refresh chat search and try again.
      </ChatErrorNotice>}
      <section
        className={styles.timeline}
        data-welcome={state.items.length === 0 && !loading || undefined}
        aria-busy={loading || streaming}
        aria-label="Conversation"
        ref={timelineRef}
        onPointerDown={pauseAutoScroll}
        onWheel={pauseAutoScroll}
      >
        <div className={styles.timelineContent}>
          {state.items.length === 0 && !loading && (
            <ChatWelcome workspaceName={workspaceName} />
          )}
          {loading && <div className={styles.loading}><Sparkles aria-hidden="true" /> Loading conversation…</div>}
          <ChatTimelineHistory
            key={`${state.activeSessionId ?? ''}:${state.items[0]?.id ?? ''}`}
            items={state.items}
            timelineRef={timelineRef}
            loading={loading}
            streaming={streaming}
            completedTurns={completedTurns}
            savedTurns={savedTurns}
            onReviewFileChanges={onReviewFileChanges}
            historyTarget={historyTarget}
            onHistoryTargetHandled={handleHistoryTarget}
            onRevealHistoryItem={controller.scrollToHistoryItem}
          />
          {streaming && !loading && <LoadingState type="thinking" className={styles.thinking} />}
        </div>
      </section>

      {showScrollToBottom && state.items.length > 0 && (
        <div className={styles.scrollToBottomControl}>
          <NeumorphicButton
            raised
            aria-label="Scroll to latest message"
            className="sidebar-heading-action"
            onClick={scrollToBottom}
          >
            <ArrowDown aria-hidden="true" />
          </NeumorphicButton>
        </div>
      )}
    </>
  );
}
