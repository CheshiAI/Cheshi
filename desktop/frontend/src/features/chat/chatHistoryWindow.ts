export const CHAT_HISTORY_PAGE_SIZE = 30;

export function previousChatHistoryStart(start: number): number {
  return Math.max(0, start - CHAT_HISTORY_PAGE_SIZE);
}

interface ScrollContainer {
  scrollTop: number;
}

interface HistoryAnchor {
  isConnected: boolean;
  getBoundingClientRect(): { top: number };
}

/** Measure a retained row so native scroll anchoring is not applied twice. */
export function captureChatHistoryAnchor(timeline: ScrollContainer, anchor: HistoryAnchor): () => void {
  const top = anchor.getBoundingClientRect().top;
  return () => {
    if (anchor.isConnected) timeline.scrollTop += anchor.getBoundingClientRect().top - top;
  };
}
