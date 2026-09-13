import { GitFork, History, MessageSquareText } from 'lucide-react';
import { useRef, useState } from 'react';
import { LoadingState, Modal, NeumorphicButton } from '../../shared/ui';
import type { ChatWorkspaceController } from './useChatWorkspace';
import styles from './ChatSplitDialog.module.css';

export function ChatHistoryOpenDialog({ workspace, sessionId, sessionTitle, paneId, onResume, onOpened, onClose }: {
  workspace: ChatWorkspaceController;
  sessionId: string;
  sessionTitle: string;
  paneId: string;
  onResume: () => Promise<boolean>;
  onOpened: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'resume' | 'fork'>('resume');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const completed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const forkReason = workspace.historyForkReason(sessionId, paneId);
  const busy = pending || workspace.splitPending;
  const canOpen = !busy && (mode === 'resume' || forkReason === null);
  const close = () => { if (!busy && !pendingRef.current) onClose(); };
  const open = async () => {
    if (!canOpen || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    workspace.dismissError();
    try {
      // Paint the busy state before opening and rendering a potentially large history.
      await new Promise<void>(resolve => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
      const opened = mode === 'resume' ? await onResume() : await workspace.forkHistorySession(sessionId, paneId);
      if (opened) { completed.current = true; onOpened(); }
      else setError('Could not open the conversation. Please try again.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return (
    <Modal className={styles.historyDialog} title="Open conversation" titleIcon={<MessageSquareText aria-hidden="true" />}
      closeDisabled={busy} restoreFocus={() => !completed.current} onClose={close}>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void open(); }}>
        <p className={styles.sessionTitle} title={sessionTitle}>{sessionTitle}</p>
        <fieldset className={styles.options} disabled={busy}>
          <legend>How would you like to continue?</legend>
          <label className={styles.option} data-selected={mode === 'resume' ? 'true' : undefined}>
            <input autoFocus type="radio" name="chat-history-mode" value="resume" checked={mode === 'resume'} onChange={() => setMode('resume')} />
            <History aria-hidden="true" /><span><strong>Resume</strong><small>Continue the existing conversation.</small></span>
          </label>
          <label className={styles.option} data-selected={mode === 'fork' ? 'true' : undefined} title={forkReason ?? undefined}>
            <input type="radio" name="chat-history-mode" value="fork" checked={mode === 'fork'} disabled={forkReason !== null} onChange={() => setMode('fork')} />
            <GitFork aria-hidden="true" /><span><strong>Fork</strong><small>{forkReason ?? 'Copy this conversation and continue independently in the current pane.'}</small></span>
          </label>
        </fieldset>
        {(workspace.error || error) && <p role="alert">{workspace.error || error}</p>}
        {busy && <LoadingState type={mode === 'fork' ? 'processing' : 'preparing'}
          label={mode === 'fork' ? 'Creating fork…' : 'Opening conversation…'} className={styles.openingProgress} />}
        <div className={styles.buttons}>
          <NeumorphicButton size="standard" raised type="button" disabled={busy} onClick={close}>Cancel</NeumorphicButton>
          <NeumorphicButton size="standard" raised type="submit" disabled={!canOpen} aria-busy={busy}>{mode === 'fork' ? 'Fork conversation' : 'Resume conversation'}</NeumorphicButton>
        </div>
      </form>
    </Modal>
  );
}
