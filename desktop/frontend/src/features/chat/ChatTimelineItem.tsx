import {
  AlertCircle,
  Database,
  FileCode2,
  Image,
  Search,
  Wrench,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';

import { parseChatRelayMessage } from '../../../../shared/chat-relay';
import { parseSavedChatTurnPrompt } from '../../../../shared/chat-saved-turn-continuation';
import { ContentCard } from '../../shared/ui';
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
import { reasoningMarkdown } from './chatReasoningPresentation';

function ActivityIcon({ item }: { item: ChatActivityItem }) {
  if (item.activity === 'files') return <FileCode2 aria-hidden="true" />;
  if (item.activity === 'search') return <Search aria-hidden="true" />;
  if (item.activity === 'image') return <Image aria-hidden="true" />;
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
    {turn && savedTurns ? <ChatTurnActions turn={turn} savedTurns={savedTurns} usageDetails={usageDetails} /> : usageDetails}
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
    return <section className={styles.reasoning} aria-label="Reasoning">
      <MessageContent text={reasoningMarkdown(item.text)} presentation="description" />
    </section>;
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
    return <ContentCard className={styles.activity} icon={<ActivityIcon item={item} />} title={item.label} description={item.detail}
      data-activity={item.activity} data-status={item.status}
      status={item.status === 'inProgress' ? <span role="status">In progress</span>
        : item.status === 'failed' ? 'Failed' : item.status === 'declined' ? 'Declined'
          : item.status === 'interrupted' ? 'Response stopped' : item.status === 'completed' ? 'Completed' : undefined} />;
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
