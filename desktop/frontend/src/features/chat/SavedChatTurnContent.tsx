import { ChevronDown } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';
import { NeumorphicButton } from '../../shared/ui';
import { MessageContent } from './MessageContent';
import styles from './SavedChatTurnsPanel.module.css';

const EXCERPT_HEIGHT = 240;

export function SavedChatTurnContent({ record }: { record: Pick<ChatSavedTurn, 'userText' | 'assistantText'> }) {
  const id = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const overflowing = contentHeight !== null && contentHeight > EXCERPT_HEIGHT + 1;
  useLayoutEffect(() => {
    const content = contentRef.current;
    const exchange = content?.firstElementChild;
    if (!exchange) return;
    const measure = () => {
      const height = exchange.getBoundingClientRect().height;
      if (height > 0) setContentHeight(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(exchange);
    return () => observer.disconnect();
  }, [record.userText, record.assistantText]);

  return <>
    <div id={id} ref={contentRef} className={styles.excerpt} data-expanded={expanded}
      style={{
        height: contentHeight === null ? undefined : expanded ? contentHeight : Math.min(contentHeight, EXCERPT_HEIGHT),
        maxHeight: contentHeight === null ? EXCERPT_HEIGHT : undefined,
      }}>
      <div className={styles.exchange}>
        {record.userText && <section aria-label="Saved question">
          <h3>You</h3>
          <MessageContent text={record.userText} />
        </section>}
        <section aria-label="Saved answer">
          <h3>Assistant</h3>
          <MessageContent text={record.assistantText} />
        </section>
      </div>
    </div>
    {(overflowing || expanded) && <NeumorphicButton raised active={expanded} className={styles.detailsButton}
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
      <span>{expanded ? 'Show less' : 'View details'}</span><ChevronDown aria-hidden="true" />
    </NeumorphicButton>}
  </>;
}
