import type { KeyboardEvent } from 'react';
import type { ChatTimelineItem } from './model';

export interface InputHistoryState {
  scope: string;
  entries: { id: string; text: string }[];
  selected: number;
}

export function createChatInputHistory() {
  let state: InputHistoryState = { scope: '', entries: [], selected: 0 };
  const listeners = new Set<() => void>();
  const update = (next: InputHistoryState) => { state = next; listeners.forEach(listener => listener()); };
  const close = () => { if (state.entries.length) update({ scope: '', entries: [], selected: 0 }); };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close,
    open(scope: string, items: ChatTimelineItem[]) {
      const entries = items.flatMap(item => item.kind === 'user' && !item.pending && !item.delivery && item.text.trim()
        ? [{ id: item.id, text: item.text }] : []).reverse();
      if (!entries.length) return false;
      update({ scope, entries, selected: 0 });
      return true;
    },
    highlight(index: number) {
      if (Number.isInteger(index) && index >= 0 && index < state.entries.length && index !== state.selected) {
        update({ ...state, selected: index });
      }
    },
    move(offset: -1 | 1) {
      if (state.entries.length) update({ ...state, selected: Math.max(0, Math.min(state.entries.length - 1, state.selected + offset)) });
    },
    take(scope: string, index = state.selected) {
      const entry = state.scope === scope ? state.entries[index] : undefined;
      close();
      return entry?.text ?? null;
    },
  };
}

export function handleInputHistoryKey(event: KeyboardEvent<HTMLElement>, options: {
  open: boolean; enabled: boolean; draft: string;
  show(): boolean; move(offset: -1 | 1): void; select(): void; close(): void;
}): boolean {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
  if (options.open && event.key === 'Tab') { options.close(); return false; }
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || !options.enabled) return false;
  if (options.open) {
    if (event.key === 'Escape') options.close();
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') options.move(event.key === 'ArrowUp' ? -1 : 1);
    else if (event.key === 'Enter') options.select();
    else return false;
  } else if (event.key !== 'ArrowUp' || options.draft !== '' || !options.show()) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
