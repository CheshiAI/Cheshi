import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ChatsSnapshot } from '../../../../shared/agent-chats';

interface ReadingPosition {
  top: number;
  pinned: boolean;
  known: Set<string>;
  unread: Set<string>;
  anchor?: { id: string; offset: number };
}

/** Keep identity tracking independent of message text, streaming and room selection. */
export function useChatsScroll(snapshot: ChatsSnapshot, loaded: boolean, roomId: string | null,
  active: boolean, scrollNode: RefObject<HTMLDivElement | null>) {
  const positions = useRef(new Map<string, ReadingPosition>());
  const [unreadCount, setUnreadCount] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const current = () => roomId ? positions.current.get(roomId) : undefined;
  const publish = () => {
    setUnreadCount(current()?.unread.size ?? 0);
    setAwayFromBottom(current()?.pinned === false);
  };
  const capture = (node: HTMLDivElement, position: ReadingPosition) => {
    position.top = node.scrollTop;
    const top = node.getBoundingClientRect().top;
    const articles = [...node.querySelectorAll<HTMLElement>('[data-message-id]')];
    const anchor = articles.find(article => article.getBoundingClientRect().bottom > top);
    position.anchor = anchor ? { id: anchor.dataset.messageId!, offset: anchor.getBoundingClientRect().top - top } : undefined;
  };
  const restore = () => {
    const node = scrollNode.current, position = current();
    if (!active || !node || !position) return;
    if (position.pinned) node.scrollTop = node.scrollHeight;
    else {
      const anchor = position.anchor;
      const article = anchor && [...node.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find(element => element.dataset.messageId === anchor.id);
      node.scrollTop = article && anchor
        ? node.scrollTop + article.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset
        : position.top;
    }
    capture(node, position);
  };
  useLayoutEffect(() => {
    if (!loaded) return;
    for (const room of snapshot.rooms) {
      const ids = new Set(snapshot.messages.filter(message => message.roomId === room.id).map(message => message.id));
      let position = positions.current.get(room.id);
      if (!position) {
        position = { top: 0, pinned: true, known: ids, unread: new Set() };
        positions.current.set(room.id, position);
      } else {
        for (const id of ids) if (!position.known.has(id) && !position.pinned) position.unread.add(id);
        for (const id of position.unread) if (!ids.has(id)) position.unread.delete(id);
        for (const id of ids) position.known.add(id);
      }
    }
    for (const id of positions.current.keys()) if (!snapshot.rooms.some(room => room.id === id)) positions.current.delete(id);
    restore(); publish();
  }, [snapshot, loaded, roomId, active]);
  useLayoutEffect(() => {
    const node = scrollNode.current;
    if (!active || !node) return;
    const observer = new ResizeObserver(restore);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    observer.observe(node);
    return () => observer.disconnect();
  }, [roomId, active, loaded]);
  return {
    unreadCount,
    awayFromBottom,
    isPinned: () => current()?.pinned ?? true,
    restore,
    onScroll: () => {
      const node = scrollNode.current, position = current();
      if (!active || !node || !position) return;
      position.pinned = node.scrollHeight - node.clientHeight - node.scrollTop < 48;
      capture(node, position);
      if (position.pinned) position.unread.clear();
      publish();
    },
    jumpToLatest: () => {
      const position = current();
      if (!position) return;
      position.pinned = true; position.unread.clear(); restore(); publish();
    },
  };
}
