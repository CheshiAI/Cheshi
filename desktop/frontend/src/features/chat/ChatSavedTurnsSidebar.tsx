import { ClipboardClock } from 'lucide-react';
import { useId, useRef, useState, type RefObject } from 'react';
import { NeumorphicButton, SlidingSidePanel, Tooltip } from '../../shared/ui';
import { SavedChatTurnsPanel } from './SavedChatTurnsPanel';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';
import styles from './ChatSavedTurnsSidebar.module.css';

export function ChatSavedTurnsSidebar({ savedTurns, onContinueSavedTurn, continuationDisabledReason, blurSourceRef }: {
  savedTurns: SavedChatTurnsController;
  blurSourceRef?: RefObject<HTMLElement | null>;
  onContinueSavedTurn?: (record: ChatSavedTurn) => Promise<boolean>;
  continuationDisabledReason?: string | null;
}) {
  const id = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    railRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    setOpen(false);
  };
  return <aside className={styles.inspector} data-open={open} aria-label="Conversation tools"
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
            setOpen(!open);
          }}><ClipboardClock aria-hidden="true" /></NeumorphicButton>
      )}</Tooltip>
    </div>
  </aside>;
}
