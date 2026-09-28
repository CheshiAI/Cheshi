import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { ClipboardClock, History, RefreshCw, Trash2, X } from 'lucide-react';
import { useId, useRef, useState, type RefObject } from 'react';
import type { ChatRelayHistoryRecord, ChatRelayState } from '../../../../shared/chat-relay';
import { LoadingState, NeumorphicButton, SlidingSidePanel, Tooltip } from '../../shared/ui';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import type { ChatRelayController } from './useChatRelay';
import styles from './ChatRelayHistoryPanel.module.css';
import { ChatDeleteRecordDialog } from './ChatDeleteRecordDialog';
import { SavedChatTurnsPanel } from './SavedChatTurnsPanel';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';

const modeLabels = { review: 'Review', debate: 'Debate', consensus: 'Consensus' };
const statusLabels = { running: 'In progress', stopping: 'Stopping', stopped: 'Stopped', completed: 'Completed', error: 'Failed' };
const shortThread = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

function Participants({ state }: { state: ChatRelayState }) {
  return <TooltipTarget content={`A · ${state.sourceThreadId} ↔ B · ${state.targetThreadId}${state.moderatorThreadId ? ` → C · ${state.moderatorThreadId}` : ''}`}>
    <small >
      A · {shortThread(state.sourceThreadId)}<br />B · {shortThread(state.targetThreadId)}
      {state.moderatorThreadId && <><br />C · {shortThread(state.moderatorThreadId)}</>}
    </small>
  </TooltipTarget>;
}

export function ChatRelayHistoryPanel({ relay, savedTurns, onContinueSavedTurn, continuationDisabledReason, blurSourceRef }: {
  relay: ChatRelayController;
  blurSourceRef?: RefObject<HTMLElement | null>;
  savedTurns?: SavedChatTurnsController;
  onContinueSavedTurn?: (record: ChatSavedTurn) => Promise<boolean>;
  continuationDisabledReason?: string | null;
}) {
  const id = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const [activePanel, setActivePanel] = useState<'history' | 'saved' | null>(null);
  const [deleteRecord, setDeleteRecord] = useState<ChatRelayHistoryRecord | null>(null);
  const open = activePanel !== null;
  const records = relay.history.filter((record) => !relay.running || record.id !== relay.state?.id);
  const showCurrent = relay.state && (relay.running || !records.some((record) => record.id === relay.state?.id));
  const close = () => {
    railRef.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
    setActivePanel(null);
  };
  const toggle = () => {
    if (activePanel !== 'history') void relay.refreshHistory();
    setActivePanel(activePanel === 'history' ? null : 'history');
  };
  return (
    <aside className={styles.inspector} data-open={open} aria-label="Conversation tools">
      <SlidingSidePanel open={open} className={styles.panel}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          close();
        }}>
          <section className={styles.content} id={id} aria-labelledby={`${id}-button`} hidden={activePanel === 'saved'}>
            <header className={styles.heading}>
              <SidebarPanelTitle title="CONVERSATION HISTORY" />
              <div className={styles.actions}>
                <TooltipButton variant="ghost" size="icon" aria-label="Refresh conversation history" title="Refresh history"
                  disabled={relay.historyLoading || relay.historyDeleting} onClick={() => void relay.refreshHistory()}><RefreshCw aria-hidden="true" /></TooltipButton>
                <NeumorphicButton variant="ghost" size="icon" aria-label="Close conversation history panel"
                  onClick={close}><X aria-hidden="true" /></NeumorphicButton>
              </div>
            </header>
            <div className={styles.list} aria-busy={relay.historyLoading}>
              {showCurrent && relay.state && <button type="button" className={styles.record}
                data-selected={relay.resultVisible && !relay.selectedResult ? 'true' : undefined}
                aria-pressed={relay.resultVisible && !relay.selectedResult} onClick={relay.showLiveResult}>
                <strong>{relay.running ? 'Current conversation' : 'Latest conversation'}</strong>
                <span>{modeLabels[relay.state.mode]} · {statusLabels[relay.state.status]}</span>
                <Participants state={relay.state} />
              </button>}
              {relay.historyError && <div className={styles.notice} role="alert">
                <p>{relay.historyError}</p>
                <NeumorphicButton variant="standard" disabled={relay.historyLoading || relay.historyDeleting} onClick={() => void relay.refreshHistory()}>Retry</NeumorphicButton>
              </div>}
              {relay.historyLoading && <LoadingState label="loading history…"
                className={!showCurrent && records.length === 0 && !relay.historyError ? styles.emptyState : undefined} />}
              {!relay.historyLoading && !relay.historyError && !showCurrent && records.length === 0 && (
                <p className={`${styles.notice} ${styles.emptyState}`}>no conversation history yet.<br />finished conversations appear here.</p>
              )}
              {records.map((record) => (
                <div key={record.id} className={styles.recordRow}>
                  <button type="button" className={`${styles.record} ${styles.savedRecord}`}
                    data-selected={relay.resultVisible && relay.selectedResult?.id === record.id ? 'true' : undefined}
                    aria-pressed={relay.resultVisible && relay.selectedResult?.id === record.id}
                    onClick={() => relay.showResult(record)}>
                    <strong>{record.objective}</strong>
                    <span>{modeLabels[record.state.mode]} · {statusLabels[record.state.status]}</span>
                    <time dateTime={record.finishedAt ?? record.updatedAt}>{new Date(record.finishedAt ?? record.updatedAt).toLocaleString()}</time>
                    <Participants state={record.state} />
                  </button>
                  <TooltipButton variant="ghost" size="icon" className={styles.deleteButton}
                    aria-label={`Delete conversation history: ${record.objective}`} title="Delete conversation history"
                    disabled={relay.historyDeleting || relay.historyLoading}
                    onClick={() => setDeleteRecord(record)}><Trash2 aria-hidden="true" /></TooltipButton>
                </div>
              ))}
            </div>
          </section>
          {savedTurns && <section className={styles.content} id={`${id}-saved`} aria-labelledby={`${id}-saved-button`} hidden={activePanel !== 'saved'}>
            <SavedChatTurnsPanel savedTurns={savedTurns} onClose={close}
              onContinue={onContinueSavedTurn} continuationDisabledReason={continuationDisabledReason} />
          </section>}
      </SlidingSidePanel>
      <div ref={railRef} className={styles.rail} role="group" aria-label="Conversation panels">
        <Tooltip content="Conversation history" blurSourceRef={blurSourceRef}>{(triggerProps) => (
          <NeumorphicButton {...triggerProps} variant="ghost" size="icon" active={activePanel === 'history'}
            id={`${id}-button`} aria-label="Conversation history" aria-controls={id} aria-expanded={activePanel === 'history'} onClick={toggle}>
            <History aria-hidden="true" />
          </NeumorphicButton>
        )}</Tooltip>
        {savedTurns && <Tooltip content="Saved turns" blurSourceRef={blurSourceRef}>{(triggerProps) => (
          <NeumorphicButton {...triggerProps} variant="ghost" size="icon" active={activePanel === 'saved'}
            id={`${id}-saved-button`} aria-label="Saved turns" aria-controls={`${id}-saved`} aria-expanded={activePanel === 'saved'}
            onClick={() => {
              if (activePanel !== 'saved') void savedTurns.refresh();
              setActivePanel(activePanel === 'saved' ? null : 'saved');
            }}><ClipboardClock aria-hidden="true" /></NeumorphicButton>
        )}</Tooltip>}
      </div>
      {deleteRecord && <ChatDeleteRecordDialog recordTitle={deleteRecord.objective} kind="history"
        pending={relay.historyDeleting} error={relay.historyError}
        onDelete={() => relay.deleteHistory(deleteRecord.id)} onClose={() => setDeleteRecord(null)} />}
    </aside>
  );
}
