import {
  AlertCircle,
  Brain,
  Database,
  FileCode2,
  Image,
  Search,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';

import { parseChatRelayMessage } from '../../../../shared/chat-relay';
import { parseSavedChatTurnPrompt } from '../../../../shared/chat-saved-turn-continuation';
import { LiquidGlassPanel } from '../../shared/ui';
import { ChatMessageLabel } from './ChatMessageLabel';
import { relayAssistantDisplayText, relayDisplayText } from './chatRelayMessageView';
import { FileChangesActivity } from './FileChangesActivity';
import { CommandActivity } from './CommandActivity';
import { MessageContent } from './MessageContent';
import { SavedChatTurnMessage } from './SavedChatTurnMessage';
import type { ChatActivityItem, ChatTimelineItem as ChatTimelineItemModel } from './model';
import styles from './ChatView.module.css';
import { ChatTurnActions } from './ChatTurnActions';
import type { ChatSavedTurnInput } from '../../../../shared/chat-saved-turns';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import { ChatInlineQuestion } from './ChatInlineQuestion';
import { AgentActivity } from './AgentActivity';
import { HistoryRecallActivity } from './HistoryRecallActivity';

function ActivityIcon({ item }: { item: ChatActivityItem }) {
  if (item.activity === 'command') return <Terminal aria-hidden="true" />;
  if (item.activity === 'files') return <FileCode2 aria-hidden="true" />;
  if (item.activity === 'search') return <Search aria-hidden="true" />;
  if (item.activity === 'image') return <Image aria-hidden="true" />;
  if (item.activity === 'agent') return <Users aria-hidden="true" />;
  if (item.activity === 'context') return <Database aria-hidden="true" />;
  if (item.activity === 'error') return <AlertCircle aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}

interface ChatTimelineItemProps {
  item: ChatTimelineItemModel;
  streaming: boolean;
  onReviewFileChanges: (itemId: string, path?: string) => void;
  turn?: ChatSavedTurnInput;
  savedTurns?: SavedChatTurnsController;
  searchMatch?: boolean;
  usageDetails?: ReactNode;
}

export const ChatTimelineItem = memo(function ChatTimelineItem({ turn, savedTurns, searchMatch, usageDetails, ...props }: ChatTimelineItemProps) {
  return <div className={styles.timelineItem} data-chat-item-id={props.item.id} tabIndex={-1}
    data-history-search-match={searchMatch ? 'true' : undefined}>
    <TimelineItemContent {...props} />
    {turn && savedTurns && <ChatTurnActions turn={turn} savedTurns={savedTurns} usageDetails={usageDetails} />}
  </div>;
});

function TimelineItemContent({
  item,
  streaming,
  onReviewFileChanges,
}: Omit<ChatTimelineItemProps, 'turn' | 'savedTurns'>) {
  if (item.kind === 'user') {
    const relay = parseChatRelayMessage(item.text);
    const savedTurn = relay ? null : parseSavedChatTurnPrompt(item.text);
    return (
      <article className={styles.userRow} data-pending={item.pending ? 'true' : undefined}>
        <div className={styles.userMessageGroup}>
          <ChatMessageLabel author="user" createdAt={item.createdAt} relay={relay?.provenance} />
          <div className={styles.userMessage}>
            {savedTurn ? <SavedChatTurnMessage context={savedTurn} />
              : <MessageContent renderLocalImages text={relay ? relayDisplayText(relay) : item.text} />}
          </div>
          {item.delivery && <span className={styles.deliveryStatus} role="status">
            {item.delivery === 'failed' ? 'Not sent' : 'Delivery not confirmed — check the conversation before resending.'}
          </span>}
        </div>
      </article>
    );
  }
  if (item.kind === 'plan') {
    return <article className={styles.assistantRow} aria-label="Proposed plan">
      <ChatMessageLabel author="assistant" createdAt={item.createdAt} />
      <div className={styles.assistantMessage}><MessageContent text={item.text} /></div>
    </article>;
  }
  if (item.kind === 'reasoning') {
    return (
      <details className={styles.reasoning} open={streaming}>
        <summary><Brain aria-hidden="true" /><span>Reasoning</span></summary>
        <div className={styles.reasoningContent}><MessageContent text={item.text} /></div>
      </details>
    );
  }
  if (item.kind === 'activity' && item.activity === 'files' && item.changes?.length) {
    return <FileChangesActivity item={item} onReview={onReviewFileChanges} />;
  }
  if (item.kind === 'activity' && item.activity === 'command') {
    return <CommandActivity item={item} />;
  }
  if (item.kind === 'activity' && item.activity === 'agent') return <AgentActivity item={item} />;
  if (item.kind === 'activity' && item.recall) return <HistoryRecallActivity item={item} />;
  if (item.kind === 'activity') {
    return (
      <LiquidGlassPanel as="article" className={styles.activity} data-activity={item.activity} data-status={item.status}
        data-liquid-glass-backdrop={item.activity === 'search' || item.activity === 'context' || item.activity === 'error' || item.activity === 'agent' || item.activity === 'tool' ? 'true' : undefined}>
        <ActivityIcon item={item} />
        <div>
          <strong>{item.label}</strong>
          {item.detail && <span>{item.detail}</span>}
        </div>
        {item.status === 'inProgress' && <i aria-label="In progress" />}
      </LiquidGlassPanel>
    );
  }
  return (
    <article className={styles.assistantRow}>
      <ChatMessageLabel author="assistant" createdAt={item.createdAt} />
      <div className={styles.assistantMessage}>{item.asyncQuestions?.length
        ? <ChatInlineQuestion item={item} />
        : <MessageContent text={relayAssistantDisplayText(item.text, streaming)} />}</div>
    </article>
  );
}
