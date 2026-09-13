import { Bot, Speech, Users } from 'lucide-react';

import type { ChatRelayMessageProvenance } from '../../../../shared/chat-relay';
import { NeumorphicButton } from '../../shared/ui';
import { formatMessageTimestamp } from './chatViewModel';
import styles from './ChatView.module.css';

export function ChatMessageLabel({ author, createdAt = 0, relay }: {
  author: 'user' | 'assistant';
  createdAt?: number;
  relay?: ChatRelayMessageProvenance;
}) {
  const isUser = author === 'user';
  const Icon = relay ? Users : isUser ? Speech : Bot;
  const relaySources = relay ? relay.sourceThreadIds ?? [relay.sourceThreadId] : [];
  const relaySource = relaySources.map((id) => id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id).join(' + ');
  const candidateDate = new Date(createdAt * 1000);
  const date = createdAt > 0 && Number.isFinite(candidateDate.getTime()) ? candidateDate : null;

  return (
    <div className={`${styles.messageLabel} ${isUser ? styles.userLabel : ''}`}>
      <NeumorphicButton
        raised
        aria-hidden="true"
        className={`sidebar-heading-action ${styles.messageAvatar}`}
        disabled
      >
        <Icon aria-hidden="true" />
      </NeumorphicButton>
      <strong title={relay ? `From ${relaySources.join(' + ')} · ${relay.role}` : undefined}>
        {relay ? `${relay.mode === 'debate' ? 'DEBATE' : relay.mode === 'consensus' ? 'CONSENSUS' : 'RELAY'} · ${relaySource}` : isUser ? 'YOU' : 'ASSISTANT'}
      </strong>
      {date && (
        <time className={styles.messageTimestamp} dateTime={date.toISOString()}>
          {formatMessageTimestamp(date)}
        </time>
      )}
    </div>
  );
}
