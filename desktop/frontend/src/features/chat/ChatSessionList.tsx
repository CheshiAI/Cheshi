import { memo, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { MessageCircleDashed, MessageSquareText, Plus, Trash2 } from 'lucide-react';

import { LoadingIndicator, LoadingState, NeumorphicButton, SidebarPanelHeader } from '../../shared/ui';
import { OverlayScrollArea } from '../../shared/ui/OverlayScrollArea';
import type { ChatSession } from './model';
import { formatSessionElapsedTime, useChatSessionClock } from './chatSessionTime';
import styles from './ChatSessionList.module.css';

interface ChatSessionListProps {
  search?: ReactNode;
  sessions: ChatSession[];
  loading: boolean;
  activeSessionId: string | null;
  responseThreadIds: readonly string[];
  newChatDisabled: boolean;
  selectionDisabled: boolean;
  onOpen: (sessionId: string) => void;
  onNew: () => void;
  onTemporaryChat?: () => void;
  temporaryChatOpen?: boolean;
  onDelete: (sessionId: string) => void;
  deleteReason: (sessionId: string) => string | null;
}

function sessionTimestamp(session: ChatSession): number {
  return Number.isFinite(session.updatedAt) ? session.updatedAt : -Infinity;
}

const ChatSessionButton = memo(function ChatSessionButton({
  id, title, elapsed, active, responding, onOpen,
}: { id: string; title: string; elapsed: string; active: boolean; responding: boolean; onOpen: (id: string) => void }) {
  return (
    <NeumorphicButton variant="ghost" className={styles.session} aria-current={active ? 'page' : undefined}
      aria-label={title} type="button" aria-haspopup="dialog" onClick={() => onOpen(id)}>
      <span className={styles.sessionTitleRow}>
        <span className={styles.sessionTitle} title={title}>{title}</span>
        {responding && <LoadingIndicator label="Active response" />}
      </span>
      <span className={styles.sessionMetadata}>
        <span className={styles.sessionId} title={id}>{id}</span>
        <span className={styles.sessionTime}
          aria-label={elapsed === '—' ? 'Last updated time unavailable' : `Last updated ${elapsed} ago`}>{elapsed}</span>
      </span>
    </NeumorphicButton>
  );
});

export function ChatSessionList({
  search,
  sessions,
  loading,
  activeSessionId,
  responseThreadIds,
  newChatDisabled,
  selectionDisabled,
  onOpen,
  onNew,
  onTemporaryChat,
  temporaryChatOpen = false,
  onDelete,
  deleteReason,
}: ChatSessionListProps) {
  // Keep the row callback stable while invoking only the latest committed pane handlers.
  const interaction = useRef({ onOpen, selectionDisabled });
  useLayoutEffect(() => { interaction.current = { onOpen, selectionDisabled }; }, [onOpen, selectionDisabled]);
  const openSession = useCallback((id: string) => {
    if (!interaction.current.selectionDisabled) interaction.current.onOpen(id);
  }, []);
  const respondingSessions = new Set(responseThreadIds);
  const now = useChatSessionClock(sessions.length > 0);
  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a)), [sessions]);

  return (
    <section className={styles.root} aria-label="Chat history">
      <SidebarPanelHeader title="SESSIONS" icon={<MessageSquareText aria-hidden="true" />} actions={<>
        {onTemporaryChat && <NeumorphicButton
          size="icon"
          aria-label="Open temporary chat"
          title="Temporary chat · Not saved to chat history"
          aria-haspopup="dialog"
          aria-expanded={temporaryChatOpen}
          onClick={onTemporaryChat}
        >
          <MessageCircleDashed aria-hidden="true" />
        </NeumorphicButton>}
        <NeumorphicButton
          size="icon"
          aria-label="New chat"
          title="New chat"
          disabled={newChatDisabled}
          onClick={onNew}
        >
          <Plus aria-hidden="true" />
        </NeumorphicButton>
      </>} />

      <div className={styles.body}>
        {sessions.length > 0 && search}

        <OverlayScrollArea className={styles.listScroll} label="Conversation list">
        <fieldset className={styles.list} aria-label="Conversations" aria-busy={loading} disabled={selectionDisabled}>
          {loading && sessions.length === 0 && (
            <LoadingState className={styles.loading} />
          )}
          {!loading && sessions.length === 0 && (
            <div className={styles.empty}>
              <MessageSquareText aria-hidden="true" />
              <span>Your workspace chats will appear here.</span>
            </div>
          )}
          {sortedSessions.map((session) => {
            const reason = deleteReason(session.id);
            return (
              <div className={styles.sessionRow} key={session.id}>
                <ChatSessionButton id={session.id} title={session.title}
                  elapsed={formatSessionElapsedTime(session.updatedAt, now)}
                  active={session.id === activeSessionId}
                  responding={session.status === 'active' || respondingSessions.has(session.id)}
                  onOpen={openSession} />
                <NeumorphicButton variant="ghost" size="icon" className={styles.deleteButton}
                  type="button" aria-label={`Delete chat: ${session.title}`} aria-haspopup="dialog"
                  title={reason ?? 'Delete chat'}
                  disabled={reason !== null}
                  onClick={() => onDelete(session.id)}>
                  <Trash2 size={11} strokeWidth={1.7} aria-hidden="true" />
                </NeumorphicButton>
              </div>
            );
          })}
        </fieldset>
        </OverlayScrollArea>
      </div>
    </section>
  );
}
