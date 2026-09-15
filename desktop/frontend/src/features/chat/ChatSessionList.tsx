import { memo, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { MessageCircleDashed, MessageSquareText, Plus, Trash2 } from 'lucide-react';

import { LoadingState, NeumorphicButton } from '../../shared/ui';
import type { ChatSession } from './model';
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

type SessionGroup = 'Today' | 'Previous';

function sessionGroup(updatedAt: number): SessionGroup {
  const updated = new Date(updatedAt * 1_000);
  if (Number.isNaN(updated.getTime())) return 'Previous';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (updated.getTime() >= today) return 'Today';
  return 'Previous';
}

const ChatSessionButton = memo(function ChatSessionButton({
  id, title, active, responding, onOpen,
}: { id: string; title: string; active: boolean; responding: boolean; onOpen: (id: string) => void }) {
  return (
    <button className={styles.session} aria-current={active ? 'page' : undefined}
      title={title} type="button" aria-haspopup="dialog" onClick={() => onOpen(id)}>
      <MessageSquareText aria-hidden="true" />
      <span>{title}</span>
      {responding && <i aria-label="Active response" />}
    </button>
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
  const today = new Date().toDateString();
  const groups = useMemo(() => {
    const grouped = new Map<SessionGroup, ChatSession[]>([['Today', []], ['Previous', []]]);
    for (const session of sessions) grouped.get(sessionGroup(session.updatedAt))?.push(session);
    return [...grouped.entries()];
  }, [sessions, today]);

  return (
    <section className={styles.root} aria-label="Chat history">
      <header className={styles.heading}>
        <span>CHATS</span>
        <div className="sidebar-heading-actions">
          {onTemporaryChat && <NeumorphicButton
            raised
            className="sidebar-heading-action"
            aria-label="Open temporary chat"
            title="Temporary chat · Not saved to chat history"
            aria-haspopup="dialog"
            aria-expanded={temporaryChatOpen}
            onClick={onTemporaryChat}
          >
            <MessageCircleDashed aria-hidden="true" />
          </NeumorphicButton>}
          <NeumorphicButton
            raised
            className="sidebar-heading-action"
            aria-label="New chat"
            disabled={newChatDisabled}
            onClick={onNew}
          >
            <Plus aria-hidden="true" />
          </NeumorphicButton>
        </div>
      </header>

      {sessions.length > 0 && search}

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
        {groups.map(([label, entries]) => entries.length > 0 && (
          <section className={styles.group} key={label}>
            <h2>{label}</h2>
            <div className={styles.groupItems}>
              {entries.map((session) => {
                const reason = deleteReason(session.id);
                return (
                <div className={styles.sessionRow} key={session.id}>
                  <ChatSessionButton id={session.id} title={session.title}
                    active={session.id === activeSessionId}
                    responding={session.status === 'active' || respondingSessions.has(session.id)}
                    onOpen={openSession} />
                  <NeumorphicButton raised className={styles.deleteButton}
                    type="button" aria-label={`Delete chat: ${session.title}`} aria-haspopup="dialog"
                    title={reason ?? 'Delete chat'}
                    disabled={reason !== null}
                    onClick={() => onDelete(session.id)}>
                    <Trash2 size={11} strokeWidth={1.7} aria-hidden="true" />
                  </NeumorphicButton>
                </div>
                );
              })}
            </div>
          </section>
        ))}
      </fieldset>
    </section>
  );
}
