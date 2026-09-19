import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ChatSavedTurnInput } from '../../../../shared/chat-saved-turns';
import { NeumorphicButton } from '../../shared/ui';
import { ChatTimelineItem } from './ChatTimelineItem';
import { HistoryRecallTotals, recallTurnMetrics } from './HistoryRecallActivity';
import { captureChatHistoryAnchor, previousChatHistoryStart } from './chatHistoryWindow';
import type { ChatTimelineItem as TimelineItem } from './model';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import { chatHistoryItemMatches, findChatHistoryTarget, type ChatHistorySearchNavigation, type ChatHistorySearchTarget } from './chatHistorySearchNavigation';

interface ChatTimelineHistoryProps extends ChatHistorySearchNavigation {
  items: TimelineItem[];
  timelineRef: RefObject<HTMLElement | null>;
  loading: boolean;
  streaming: boolean;
  completedTurns: Map<string, ChatSavedTurnInput>;
  savedTurns?: SavedChatTurnsController;
  onReviewFileChanges: (itemId: string, path?: string) => void;
  onRevealHistoryItem?: (item: HTMLElement) => void;
}

/** Mount recent history first; retain revealed rows and their interactive state. */
export const ChatTimelineHistory = memo(function ChatTimelineHistory({
  items, timelineRef, loading, streaming, completedTurns, savedTurns, onReviewFileChanges,
  historyTarget, onHistoryTargetHandled, onRevealHistoryItem,
}: ChatTimelineHistoryProps) {
  const targetIndex = historyTarget ? items.findIndex((item) => chatHistoryItemMatches(item, historyTarget.itemId)) : -1;
  const targetElementId = items[targetIndex]?.id ?? historyTarget?.itemId;
  const [start, setStart] = useState(() => targetIndex >= 0
    ? Math.min(targetIndex, previousChatHistoryStart(items.length)) : previousChatHistoryStart(items.length));
  const [searchMatch, setSearchMatch] = useState<ChatHistorySearchTarget | null>(null);
  const restoreAnchorRef = useRef<(() => void) | null>(null);
  const previousScrollTopRef = useRef(0);
  const usageByItem = useMemo(() => recallTurnMetrics(items), [items]);

  useLayoutEffect(() => {
    if (loading || !historyTarget) return;
    restoreAnchorRef.current = null;
    if (targetIndex >= 0) setStart((current) => Math.min(current, targetIndex));
  }, [historyTarget, loading, targetIndex]);

  useEffect(() => {
    if (loading || !historyTarget || (targetIndex >= 0 && targetIndex < start)) return;
    // Run after the view resets its session scroll state and the modal releases focus.
    const frame = window.requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline) return;
      const item = findChatHistoryTarget(timeline, targetElementId ?? historyTarget.itemId);
      if (item) {
        setSearchMatch(historyTarget);
        onRevealHistoryItem?.(item);
      } else {
        setSearchMatch(null);
      }
      onHistoryTargetHandled?.(historyTarget.requestId, item !== undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [historyTarget, loading, onHistoryTargetHandled, onRevealHistoryItem, start, targetIndex, targetElementId, timelineRef]);

  useEffect(() => {
    if (!searchMatch) return;
    // Keep the destination visible briefly after the navigation request is acknowledged.
    const timeout = window.setTimeout(() => setSearchMatch(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [searchMatch]);

  const revealEarlier = useCallback(() => {
    const timeline = timelineRef.current;
    if (!timeline || loading || start === 0 || restoreAnchorRef.current) return;
    const anchor = timeline.querySelector<HTMLElement>('[data-chat-item-id]');
    if (!anchor) return;
    restoreAnchorRef.current = captureChatHistoryAnchor(timeline, anchor);
    setStart(previousChatHistoryStart);
  }, [loading, start, timelineRef]);

  useLayoutEffect(() => {
    restoreAnchorRef.current?.();
    restoreAnchorRef.current = null;
    previousScrollTopRef.current = timelineRef.current?.scrollTop ?? 0;
  }, [start, timelineRef]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || loading || start === 0) return;
    previousScrollTopRef.current = timeline.scrollTop;
    const onScroll = () => {
      const top = timeline.scrollTop;
      const scrollingUp = top < previousScrollTopRef.current;
      previousScrollTopRef.current = top;
      if (scrollingUp && top <= 160) revealEarlier();
    };
    timeline.addEventListener('scroll', onScroll, { passive: true });
    return () => timeline.removeEventListener('scroll', onScroll);
  }, [loading, revealEarlier, start, timelineRef]);

  const visibleItems = items.slice(start);

  return <>
    {start > 0 && <NeumorphicButton size="standard" disabled={loading} onClick={revealEarlier}>
      Show earlier messages
    </NeumorphicButton>}
    {visibleItems.map((item, index) => <ChatTimelineItem
      key={item.id}
      item={item}
      searchMatch={searchMatch !== null && chatHistoryItemMatches(item, searchMatch.itemId)}
      streaming={streaming && index === visibleItems.length - 1}
      turn={completedTurns.get(item.id)}
      savedTurns={savedTurns}
      usageDetails={usageByItem.has(item.id) ? <HistoryRecallTotals metrics={usageByItem.get(item.id)} /> : undefined}
      onReviewFileChanges={onReviewFileChanges}
    />)}
  </>;
});
