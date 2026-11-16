import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { Bot, Speech, Users } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ChatRelayMessageProvenance } from '../../../../shared/chat-relay';
import { NeumorphicButton } from '../../shared/ui';
import { formatMessageTimestamp } from './chatViewModel';
import styles from './ChatView.module.css';

export function ChatMessageLabel({ author, createdAt = 0, relay, name, avatar, className, children }: {
  author: 'user' | 'assistant';
  createdAt?: number;
  relay?: ChatRelayMessageProvenance;
  name?: string;
  avatar?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const isUser = author === 'user';
  const Icon = relay ? Users : isUser ? Speech : Bot;
  const relaySources = relay ? relay.sourceThreadIds ?? [relay.sourceThreadId] : [];
  const relaySource = relaySources.map((id) => id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id).join(' + ');
  const candidateDate = new Date(createdAt * 1000);
  const date = createdAt > 0 && Number.isFinite(candidateDate.getTime()) ? candidateDate : null;

  return (
    <div className={`${styles.messageLabel} ${isUser ? styles.userLabel : ''} ${className ?? ''}`}>
      <NeumorphicButton
        raised
        aria-hidden="true"
        className={`sidebar-heading-action ${styles.messageAvatar}`}
        disabled
      >
        {avatar ?? <Icon aria-hidden="true" />}
      </NeumorphicButton>
      <TooltipTarget content={relay ? `From ${relaySources.join(' + ')} · ${relay.role}` : undefined}>
        <strong >
          {relay ? `${relay.mode === 'debate' ? 'DEBATE' : relay.mode === 'consensus' ? 'CONSENSUS' : 'RELAY'} · ${relaySource}` : name ?? (isUser ? 'YOU' : 'ASSISTANT')}
        </strong>
      </TooltipTarget>
      {children}
      {date && (
        <time className={styles.messageTimestamp} dateTime={date.toISOString()}>
          {formatMessageTimestamp(date)}
        </time>
      )}
    </div>
  );
}
