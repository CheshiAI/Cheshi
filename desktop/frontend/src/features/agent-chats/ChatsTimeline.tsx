import { memo, useCallback, useMemo } from 'react';
import type { AgentChatsApi, AgentRoom, ChatsRequest, RoomMessage } from '../../../../shared/agent-chats';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import { resolveChatRecipient } from '../../../../shared/agent-chat-recipient';
import { isWorkKind } from '../../../../shared/agent-work';
import { workerWorkspaceTarget } from '../../../../shared/worker-workspace';
import { NeumorphicButton } from '../../shared/ui';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { LocalFileLinkContext, MessageContent } from '../chat/MessageContent';
import { ChatMessageLabel } from '../chat/ChatMessageLabel';
import type { ChatActivityItem } from '../chat/model';
import { verificationQuote } from '../agents/verificationPresentation';
import { WorkMessage } from '../agents/WorkMessage';
import { IsolatedTaskCard } from './IsolatedTaskCard';
import { ProjectEnvironmentSetup } from './ProjectEnvironmentSetup';
import { PermissionRequestCard } from './PermissionRequestCard';
import { VerificationCard } from './VerificationReview';
import { verificationReview, verificationReportContext, type VerificationReview } from './verificationReviewModel';
import { ExecutionRecord } from './ExecutionRecord';
import { exchangeLabel, timelineContexts, timelineIndex } from './roomTimeline';
import type { TimelineWindow } from './roomTimelineLayout';
import { ChatsMessageActions } from './ChatsMessageActions';
import { TaskWorkspace } from './TaskWorkspace';
import styles from './ChatsView.module.css';

const ChatsMessageContent = memo(MessageContent);

interface ChatsTimelineProps {
  room: AgentRoom | undefined;
  messages: RoomMessage[];
  window: TimelineWindow;
  agents: SpecialistAgent[];
  api: AgentChatsApi | undefined;
  sending: boolean;
  mutate(request: ChatsRequest): Promise<void>;
  onReply(message: RoomMessage): void;
  onRetry(message: RoomMessage): Promise<void>;
  onReviewFileChanges?: (item: ChatActivityItem | null, path?: string) => void;
  onReviewVerification?: (review: VerificationReview | null, open?: boolean) => void;
}

interface MessageRowProps extends Omit<ChatsTimelineProps, 'messages' | 'window'> {
  message: RoomMessage;
  context?: RoomMessage;
  label: string | null;
  workspace: boolean;
  reviewFileContext?: string;
  verification: VerificationReview | null;
}

const MessageRow = memo(function MessageRow({ room, message, agents, api, sending, mutate,
  onReply, onRetry, onReviewFileChanges, onReviewVerification, context, label, workspace,
  reviewFileContext, verification }: MessageRowProps) {
  const name = (id: string | null) => id === 'user' ? 'You' : [...(room?.members ?? []), ...(room?.formerMembers ?? [])].find(m => m.id === id)?.name ?? id ?? '';
  const openFile = useCallback(async (href: string) => {
    if (!api) throw new Error('Worker file links are unavailable.');
    await api.request({ action: 'open-file', roomId: message.roomId, messageId: message.id, href });
  }, [api, message.roomId, message.id]);
  const addressed = message.text.trimStart().startsWith('@')
    ? resolveChatRecipient(message.text, room?.members ?? []).recipient : null;
  const mention = addressed && addressed === message.recipient ? room?.members.find(member => member.id === addressed) : undefined;
  const copyable = message.kind === 'message' && (!message.activity || message.activity.kind === 'message');
  return <LocalFileLinkContext.Provider value={message.sender === 'user' ? null : openFile}><article className={styles.message} data-message-id={message.id} data-reply-action data-copy-action={copyable || undefined}>
    <ChatsMessageActions text={message.text} copyable={copyable}
      replyLabel={`Reply to ${(message.text || message.activity?.title || 'execution').slice(0, 80)}`}
      onReply={() => onReply(message)} />
    <div className={styles.messageBody}>
      <ChatMessageLabel author={message.sender === 'user' ? 'user' : 'assistant'} name={message.sender === 'user' ? undefined : name(message.sender)}
        avatar={message.sender === 'user' ? undefined : <AgentAvatar id={message.sender} avatar={agents.find(a => a.id === message.sender)?.avatar} />}
        createdAt={Date.parse(message.createdAt) / 1000} className={styles.metadata}>
        {message.recipient && <span>→ {name(message.recipient)}</span>}{label && <span>{label}</span>}
      </ChatMessageLabel>
      {context && <blockquote className={styles.replyQuote}>{name(context.sender)}: {context.kind === 'verification_request' || context.kind === 'verification_result' ? verificationQuote(context.kind, context.text) : context.text.slice(0, 240)}</blockquote>}
      {message.kind === 'permission_request' && message.permissionRequest ? <PermissionRequestCard message={message} workspace={room!.workspace} mutate={mutate} />
        : message.activity && message.activity.kind !== 'message' ? <ExecutionRecord activity={message.activity} messageId={message.id} onReview={onReviewFileChanges} />
        : isWorkKind(message.kind) ? <WorkMessage kind={message.kind} text={message.text} />
          : verification ? <VerificationCard review={verification} onOpen={() => onReviewVerification?.(verification, true)} />
            : <div className={styles.text}><ChatsMessageContent text={message.text || 'No text response.'} mention={mention} reviewFileContext={reviewFileContext} /></div>}
      {message.isolated && <IsolatedTaskCard message={message} mutate={mutate} />}
      {workspace && <TaskWorkspace message={message} owner={name(workerWorkspaceTarget(message)!.agentId)} mutate={mutate} />}
      {message.error && !message.goalProgress && <p role="status" className={styles.description}>{message.error}</p>}
      {message.error?.includes('Project setup required:') && <ProjectEnvironmentSetup roomId={message.roomId} mutate={mutate} />}
      {message.activity?.kind === 'message' && message.activity.truncated && <p className={styles.description}>Message shortened to the retained excerpt.</p>}
      {message.status === 'queued' && message.error && <div className={styles.links}>
        <NeumorphicButton variant="ghost" disabled={sending}
          onClick={() => { void onRetry(message); }}>Retry worker</NeumorphicButton>
      </div>}
    </div>
  </article></LocalFileLinkContext.Provider>;
});

/** Only mounted rows receive presentation work; unchanged rows retain their React tree. */
export const ChatsTimeline = memo(function ChatsTimeline({ messages, window, ...props }: ChatsTimelineProps) {
  const { room, agents } = props;
  const index = useMemo(() => timelineIndex(messages), [messages]);
  const contexts = useMemo(() => timelineContexts(messages, index), [messages, index]);
  const workspaceMessages = useMemo(() => {
    const seen = new Set<string>(), ids = new Set<string>();
    for (const message of messages) {
      if (message.activity || (message.sender !== 'user' && !message.relatedTask)) continue;
      const target = workerWorkspaceTarget(message);
      if (!target) continue;
      const key = `${target.agentId}/${target.taskId}`;
      if (!seen.has(key)) { seen.add(key); ids.add(message.id); }
    }
    return ids;
  }, [messages]);
  return <div className={styles.timelineContent}>
    {window.before > 0 && <div aria-hidden="true" data-timeline-spacer="before" style={{ height: window.before }} />}
    {messages.slice(window.start, window.end).map(message => {
      const exchange = index.exchange(message);
      const reviewFileContext = verificationReportContext(message, messages, agents, index);
      const verification = verificationReview(message, exchange, reviewFileContext, index);
      return <MessageRow key={message.id} {...props} message={message} context={contexts.get(message.id)}
        label={exchangeLabel(message, messages, index)} workspace={workspaceMessages.has(message.id)}
        reviewFileContext={reviewFileContext} verification={verification} />;
    })}
    {window.after > 0 && <div aria-hidden="true" data-timeline-spacer="after" style={{ height: window.after }} />}
    {room && !messages.length && <p className={styles.empty}>Mention an agent with @ to assign work, or reply to continue their work. Other messages stay in the room without calling an agent.</p>}
  </div>;
});
