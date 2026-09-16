import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';
import { createChatInputHistory, handleInputHistoryKey } from './chatInputHistory';
import type { ChatTimelineItem } from './model';

export function useChatInputHistory({ scope, items, draft, disabled, textareaRef, setDraft, onKeyDown }: {
  scope: string; items: ChatTimelineItem[]; draft: string; disabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setDraft(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
}) {
  const store = useMemo(createChatInputHistory, []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusAfterSelection = useRef(false);
  const selectedWithEnter = useRef(false);
  const listId = useId();
  const open = !disabled && draft === '' && state.scope === scope && state.entries.length > 0;
  useLayoutEffect(() => { store.close(); }, [store, scope, disabled, draft]);
  useLayoutEffect(() => {
    if (!focusAfterSelection.current) return;
    focusAfterSelection.current = false;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(draft.length, draft.length);
  }, [draft, textareaRef]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !textareaRef.current?.contains(event.target)) store.close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, store, textareaRef]);
  useLayoutEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, state.selected]);
  const dismiss = () => { store.close(); textareaRef.current?.focus(); };
  const select = (index?: number) => {
    if (!open) return;
    const text = store.take(scope, index);
    if (text === null) return;
    focusAfterSelection.current = true;
    setDraft(text);
  };
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && event.repeat && selectedWithEnter.current) {
      event.preventDefault(); event.stopPropagation(); return true;
    }
    return handleInputHistoryKey(event, { open, enabled: !disabled, draft,
      show: () => store.open(scope, items), move: store.move, close: dismiss,
      select: () => { selectedWithEnter.current = true; select(); } });
  };
  return {
    open, state, listId, panelRef, select, dismiss, highlight: store.highlight, close: store.close,
    onPanelKeyDown: handleKey,
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (!handleKey(event)) onKeyDown(event); },
    onKeyUp(event: KeyboardEvent<HTMLElement>) { if (event.key === 'Enter') selectedWithEnter.current = false; },
  };
}
