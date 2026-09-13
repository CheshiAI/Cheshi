import type { ChatTimelineItem } from './model';

export interface ChatHistorySearchTarget {
  threadId: string;
  itemId: string;
  requestId: number;
}

export interface ChatHistorySearchNavigation {
  historyTarget?: ChatHistorySearchTarget | null;
  onHistoryTargetHandled?: (requestId: number, found: boolean) => void;
}

export function findChatHistoryTarget(timeline: HTMLElement, itemId: string): HTMLElement | undefined {
  return Array.from(timeline.querySelectorAll<HTMLElement>('[data-chat-item-id]'))
    .find((element) => element.dataset.chatItemId === itemId);
}
export function chatHistoryItemMatches(item: ChatTimelineItem, itemId: string): boolean {
  return item.id === itemId || (item.kind === 'user' && item.providerItemId === itemId);
}
