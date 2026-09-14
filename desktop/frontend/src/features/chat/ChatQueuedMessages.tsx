import { ListOrdered, RotateCcw } from 'lucide-react';

import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import type { ChatQueuedMessage } from './chatMessageQueue';
import styles from './ChatQueuedMessages.module.css';

const statusLabels: Record<ChatQueuedMessage['status'], string> = {
  queued: 'Waiting',
  sending: 'Sending…',
  paused: 'Paused',
  unknown: 'Delivery unconfirmed',
};

export function ChatQueuedMessages({ messages, onRemove, onRetry, disabled = false }: {
  messages: readonly ChatQueuedMessage[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  disabled?: boolean;
}) {
  if (messages.length === 0) return null;

  return (
    <LiquidGlassPanel as="section" className={styles.panel} data-liquid-glass-backdrop="true" aria-label="Queued instructions">
      <div className={styles.heading}>
        <ListOrdered aria-hidden="true" />
        <strong>Queued instructions</strong>
        <span className={styles.count} aria-label={`${messages.length} queued instructions`}>{messages.length}</span>
        <span className={styles.description}>Sent after the current task</span>
      </div>
      <ol className={styles.list}>
        {messages.map((message) => (
          <li key={message.id} className={styles.item}>
            <div className={styles.row}>
              <div className={styles.copy}>
                <p className={styles.text}>{message.input.draft}</p>
                {(message.input.selectedSkill || message.input.attachments.length > 0) && <div className={styles.metadata}>
                  {message.input.selectedSkill && <span>Skill: {message.input.selectedSkill.displayName}</span>}
                  {message.input.attachments.length > 0 && <span title={message.input.attachments.map(({ name }) => name).join('\n')}>
                    {message.input.attachments.length} {message.input.attachments.length === 1 ? 'attachment' : 'attachments'}
                  </span>}
                </div>}
                {message.message && <p className={styles.message}>{message.message}</p>}
                {message.status === 'unknown' && <p className={styles.message}>Check this conversation before sending again.</p>}
              </div>
              <div className={styles.actions}>
                {message.status === 'paused' && <NeumorphicButton raised size="icon" disabled={disabled}
                  aria-label="Resume queued instructions" title="Resume queued instructions" onClick={() => onRetry(message.id)}>
                  <RotateCcw aria-hidden="true" />
                </NeumorphicButton>}
                <button type="button" className={styles.remove} disabled={disabled || message.status === 'sending'}
                  aria-label={message.status === 'unknown' ? 'Dismiss unconfirmed instruction' : 'Cancel queued instruction'}
                  onClick={() => onRemove(message.id)}>
                  <span className={styles.status}>{statusLabels[message.status]}</span>
                  <span className={styles.cancel} aria-hidden="true">{message.status === 'unknown' ? 'Dismiss' : 'Cancel'}</span>
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </LiquidGlassPanel>
  );
}

export function ChatQueueHint() {
  return <p className={styles.hint}>Tab to queue · Enter to send now</p>;
}
