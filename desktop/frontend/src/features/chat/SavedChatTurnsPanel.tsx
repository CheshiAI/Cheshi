import { ChevronRight, MessageSquarePlus, RefreshCw, Trash2, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';
import { NeumorphicButton } from '../../shared/ui';
import { ChatDeleteRecordDialog } from './ChatDeleteRecordDialog';
import { SavedChatTurnContent } from './SavedChatTurnContent';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import styles from './SavedChatTurnsPanel.module.css';

interface SavedChatTurnsPanelProps {
  savedTurns: SavedChatTurnsController;
  onClose: () => void;
  onContinue?: (record: ChatSavedTurn) => Promise<boolean>;
  continuationDisabledReason?: string | null;
}

export function SavedChatTurnsPanel({ savedTurns, onClose, onContinue, continuationDisabledReason }: SavedChatTurnsPanelProps) {
  const accordionName = useId();
  const [continuingId, setContinuingId] = useState<string | null>(null);
  const [continuationError, setContinuationError] = useState<{ id: string; message: string } | null>(null);
  const pendingRef = useRef(false);
  const [deleteRecord, setDeleteRecord] = useState<ChatSavedTurn | null>(null);
  const continueTurn = async (record: ChatSavedTurn) => {
    if (!onContinue || continuationDisabledReason || pendingRef.current || savedTurns.deleting) return;
    pendingRef.current = true;
    setContinuingId(record.id);
    setContinuationError(null);
    try {
      if (!await onContinue(record)) {
        setContinuationError({ id: record.id, message: 'Could not start the conversation. Check the chat pane for details and retry.' });
      }
    } catch (error) {
      setContinuationError({ id: record.id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      pendingRef.current = false;
      setContinuingId(null);
    }
  };
  return <section className={styles.content} aria-label="Saved turns">
    <header className={styles.heading}>
      <span>Saved turns</span>
      <div className={styles.actions}>
        <NeumorphicButton raised className={styles.button} aria-label="Refresh saved turns" title="Refresh saved turns"
          disabled={savedTurns.loading || savedTurns.deleting} onClick={() => void savedTurns.refresh()}><RefreshCw aria-hidden="true" /></NeumorphicButton>
        <NeumorphicButton raised className={styles.button} aria-label="Close saved turns panel"
          onClick={onClose}><X aria-hidden="true" /></NeumorphicButton>
      </div>
    </header>
    <div className={styles.list} aria-busy={savedTurns.loading}>
      {savedTurns.error && <div className={styles.notice} role="alert">
        <p>{savedTurns.error}</p>
        <NeumorphicButton raised disabled={savedTurns.loading || savedTurns.deleting} onClick={() => void savedTurns.refresh()}>Retry</NeumorphicButton>
      </div>}
      {savedTurns.loading && <p className={styles.notice} role="status">Loading saved turns…</p>}
      {!savedTurns.loading && !savedTurns.error && savedTurns.records.length === 0
        && <p className={styles.notice}>No saved turns yet. Use Save turn below an assistant response to keep it here.</p>}
      {savedTurns.records.map((record) => <div key={record.id} className={styles.recordRow}>
        <details className={styles.record} name={accordionName}>
          <summary className={styles.summary}>
            <ChevronRight aria-hidden="true" className={styles.chevron} />
            <span className={styles.preview}>
              <strong>{record.sessionTitle || 'Untitled conversation'}</strong>
              <span>{record.userText || record.assistantText}</span>
              <time dateTime={record.savedAt}>{new Date(record.savedAt).toLocaleString()}</time>
            </span>
          </summary>
          <div className={styles.body}>
            <small className={styles.source}>Session · {record.threadId}</small>
            <SavedChatTurnContent record={record} />
            <NeumorphicButton raised className={styles.continueButton}
              disabled={!onContinue || Boolean(continuationDisabledReason) || continuingId !== null || savedTurns.deleting}
              title={continuationDisabledReason ?? 'Start a new session with this saved question and answer'}
              onClick={() => void continueTurn(record)}>
              <MessageSquarePlus aria-hidden="true" />
              <span>{continuingId === record.id ? 'Starting new session…' : 'Continue in new session'}</span>
            </NeumorphicButton>
            {continuationError?.id === record.id && <p className={styles.notice} role="alert">{continuationError.message}</p>}
          </div>
        </details>
        <NeumorphicButton raised className={`${styles.button} ${styles.deleteButton}`}
          aria-label={`Delete saved turn: ${record.sessionTitle || 'Untitled conversation'}`} title="Delete saved turn"
          disabled={savedTurns.deleting || savedTurns.loading || continuingId !== null}
          onClick={() => setDeleteRecord(record)}><Trash2 aria-hidden="true" /></NeumorphicButton>
      </div>)}
    </div>
    {deleteRecord && <ChatDeleteRecordDialog recordTitle={deleteRecord.sessionTitle || 'Untitled conversation'} kind="turn"
      pending={savedTurns.deleting} error={savedTurns.error}
      onDelete={() => savedTurns.remove(deleteRecord.id)} onClose={() => setDeleteRecord(null)} />}
  </section>;
}
