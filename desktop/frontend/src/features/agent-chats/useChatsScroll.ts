import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ChatsSnapshot, RoomMessage } from '../../../../shared/agent-chats';
import { MAX_TIMELINE_ROWS, RoomTimelineLayout } from './roomTimelineLayout';

interface ReadingPosition {
  top: number;
  pinned: boolean;
  known: Set<string>;
  unread: Set<string>;
  anchor?: { id: string; offset: number };
}

/** One owner coordinates virtual row heights, reading anchors and bottom following. */
export function useChatsScroll(snapshot: ChatsSnapshot, loaded: boolean, roomId: string | null,
  active: boolean, scrollNode: RefObject<HTMLDivElement | null>, messages: RoomMessage[]) {
  const positions = useRef(new Map<string, ReadingPosition>());
  const layouts = useRef(new Map<string | null, RoomTimelineLayout>());
  const [revision, setRevision] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const layout = useMemo(() => {
    let value = layouts.current.get(roomId);
    if (!value) { value = new RoomTimelineLayout(); layouts.current.set(roomId, value); }
    return value;
  }, [roomId]);
  useMemo(() => layout.update(messages), [layout, messages]);
  const virtual = messages.length > MAX_TIMELINE_ROWS;
  const current = () => roomId ? positions.current.get(roomId) : undefined;
  const position = current();
  const anchorTop = position?.anchor && layout.offset(position.anchor.id);
  const top = typeof anchorTop === 'number' ? anchorTop - position!.anchor!.offset : position?.top ?? 0;
  const range = layout.window(top, scrollNode.current?.clientHeight || 600, position?.pinned !== false);
  const window = useMemo(() => range, [range.start, range.end, range.before, range.after]);
  const refresh = () => setRevision(value => value + 1);
  const refreshWindow = (node: HTMLDivElement, reading: ReadingPosition) => {
    const next = layout.window(node.scrollTop, node.clientHeight || 600, reading.pinned);
    if (next.start !== window.start || next.end !== window.end || next.before !== window.before || next.after !== window.after) refresh();
  };
  const publish = () => {
    setUnreadCount(current()?.unread.size ?? 0);
    setAwayFromBottom(current()?.pinned === false);
  };
  const capture = (node: HTMLDivElement, reading: ReadingPosition) => {
    reading.top = node.scrollTop;
    if (reading.pinned) { reading.anchor = undefined; return; }
    const viewportTop = node.getBoundingClientRect().top;
    const articles = node.querySelectorAll<HTMLElement>('[data-message-id]');
    let low = 0, high = articles.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (articles[middle]!.getBoundingClientRect().bottom > viewportTop) high = middle;
      else low = middle + 1;
    }
    const article = articles[low], rect = article?.getBoundingClientRect();
    // A scrollbar drag can land in a spacer before the next React commit.
    reading.anchor = article && rect && (!virtual || rect.top <= viewportTop)
      ? { id: article.dataset.messageId!, offset: rect.top - viewportTop }
      : virtual ? layout.anchor(node.scrollTop) : undefined;
  };
  const measure = (node: HTMLDivElement) => {
    if (!virtual) return false;
    const rows = [...node.querySelectorAll<HTMLElement>('[data-message-id]')]
      .map(article => [article.dataset.messageId!, article.getBoundingClientRect().height] as const);
    return layout.measure(rows, node.clientWidth);
  };
  const restore = () => {
    const node = scrollNode.current, reading = current();
    if (!active || !node || !reading) return;
    if (measure(node)) { refresh(); return; }
    if (reading.pinned) node.scrollTop = node.scrollHeight;
    else {
      const anchor = reading.anchor;
      const article = anchor && [...node.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find(element => element.dataset.messageId === anchor.id);
      const offset = anchor && layout.offset(anchor.id);
      node.scrollTop = article && anchor
        ? node.scrollTop + article.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset
        : virtual && anchor && offset !== undefined ? offset - anchor.offset : reading.top;
    }
    capture(node, reading);
    refreshWindow(node, reading);
  };
  useLayoutEffect(() => {
    if (!loaded) return;
    const byRoom = new Map(snapshot.rooms.map(room => [room.id, new Set<string>()]));
    for (const message of snapshot.messages) byRoom.get(message.roomId)?.add(message.id);
    for (const [id, ids] of byRoom) {
      const reading = positions.current.get(id);
      if (!reading) positions.current.set(id, { top: 0, pinned: true, known: ids, unread: new Set() });
      else {
        for (const messageId of ids) if (!reading.known.has(messageId) && !reading.pinned) reading.unread.add(messageId);
        for (const messageId of reading.unread) if (!ids.has(messageId)) reading.unread.delete(messageId);
        reading.known = ids;
      }
    }
    for (const id of positions.current.keys()) if (!byRoom.has(id)) positions.current.delete(id);
    for (const id of layouts.current.keys()) if (id !== roomId && (id === null || !byRoom.has(id))) layouts.current.delete(id);
    publish();
  }, [snapshot, loaded, roomId]);
  useLayoutEffect(() => { restore(); publish(); }, [snapshot, loaded, roomId, active, window, revision]);
  useLayoutEffect(() => {
    const node = scrollNode.current;
    if (!active || !node) return;
    const observer = new ResizeObserver(restore);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    observer.observe(node);
    // Expanded command output and images can change a row without changing the journal.
    if (virtual) for (const article of node.querySelectorAll('[data-message-id]')) observer.observe(article);
    return () => observer.disconnect();
  }, [roomId, active, loaded, window, snapshot, revision]);
  return {
    window,
    unreadCount,
    awayFromBottom,
    restore,
    onScroll: () => {
      const node = scrollNode.current, reading = current();
      if (!active || !node || !reading) return;
      reading.pinned = node.scrollHeight - node.clientHeight - node.scrollTop < 48;
      capture(node, reading);
      if (reading.pinned) reading.unread.clear();
      publish(); refreshWindow(node, reading);
    },
    jumpToLatest: () => {
      const reading = current();
      if (!reading) return;
      reading.pinned = true; reading.anchor = undefined; reading.unread.clear();
      publish(); refresh();
    },
  };
}
