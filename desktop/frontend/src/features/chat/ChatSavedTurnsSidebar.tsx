import { ClipboardClock } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { NeumorphicButton, SlidingSidePanel, Tooltip } from '../../shared/ui';
import { SavedChatTurnsPanel } from './SavedChatTurnsPanel';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';
import styles from './ChatSavedTurnsSidebar.module.css';
import { createChatSidebarMotion } from './chatSidebarMotion';

export function ChatSavedTurnsSidebar({ savedTurns, onContinueSavedTurn, continuationDisabledReason, blurSourceRef }: {
  savedTurns: SavedChatTurnsController;
  blurSourceRef?: RefObject<HTMLElement | null>;
  onContinueSavedTurn?: (record: ChatSavedTurn) => Promise<boolean>;
  continuationDisabledReason?: string | null;
}) {
  const id = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [motion] = useState(createChatSidebarMotion);
  useEffect(() => () => motion.dispose(), [motion]);
  const [open, setOpen] = useState(false);
  const changeOpen = (next: boolean) => {
    motion.begin(blurSourceRef?.current, inspectorRef.current?.querySelector<HTMLElement>('[data-open]') ?? null);
    setOpen(next);
  };
  const close = () => {
    railRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    changeOpen(false);
  };
  return <aside ref={inspectorRef} className={styles.inspector} data-open={open} aria-label="Conversation tools"
    onKeyDown={event => {
      if (!open || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
    <SlidingSidePanel open={open} className={styles.panel}>
      <section className={styles.content} id={id} aria-labelledby={`${id}-button`}>
        <SavedChatTurnsPanel savedTurns={savedTurns} onClose={close}
          onContinue={onContinueSavedTurn} continuationDisabledReason={continuationDisabledReason} />
      </section>
    </SlidingSidePanel>
    <div ref={railRef} className={styles.rail} role="group" aria-label="Conversation panels">
      <Tooltip content="Saved turns" blurSourceRef={blurSourceRef}>{triggerProps => (
        <NeumorphicButton {...triggerProps} variant="ghost" size="icon" active={open}
          id={`${id}-button`} aria-label="Saved turns" aria-controls={id} aria-expanded={open}
          onClick={() => {
            if (!open) void savedTurns.refresh();
            changeOpen(!open);
          }}><ClipboardClock aria-hidden="true" /></NeumorphicButton>
      )}</Tooltip>
    </div>
  </aside>;
}
