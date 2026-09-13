import { Columns2, GitFork, Plus, Rows2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { chatRelayContextIds } from '../../../../shared/chat-relay';
import { Modal, NeumorphicButton } from '../../shared/ui';
import type { SplitPaneDirection } from '../../shared/ui/splitPaneModel';
import { chatForkUnavailableReason } from './chatWorkspaceModel';
import type { ChatWorkspaceController } from './useChatWorkspace';
import styles from './ChatSplitDialog.module.css';

export function ChatSplitDialog({ workspace, paneId, direction, sourceThreadId, onClose }: {
  workspace: ChatWorkspaceController;
  paneId: string;
  direction: SplitPaneDirection;
  sourceThreadId: string | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'new' | 'fork'>('new');
  const completed = useRef(false);
  const source = workspace.controllers[paneId]?.state;
  const locked = workspace.relay.running && workspace.relay.state !== null
    && chatRelayContextIds(workspace.relay.state).includes(paneId);
  const forkReason = source?.activeSessionId !== sourceThreadId ? 'The source conversation changed. Reopen this dialog.'
    : chatForkUnavailableReason(source, locked);
  const busy = workspace.splitPending;
  const canSplit = !busy && workspace.paneIds.includes(paneId) && workspace.paneIds.length < 32
    && (mode === 'new' || !forkReason);
  const split = async () => {
    if (!canSplit) return;
    const opened = await workspace.splitPane(paneId, direction, mode, sourceThreadId ?? undefined);
    if (opened) { completed.current = true; onClose(); }
  };
  return (
    <Modal className={styles.splitDialog} title={direction === 'down' ? 'Split chat down' : 'Split chat right'}
      titleIcon={direction === 'down' ? <Rows2 aria-hidden="true" /> : <Columns2 aria-hidden="true" />}
      restoreFocus={() => !completed.current} onClose={() => { if (!busy) onClose(); }}>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void split(); }}>
        <fieldset className={styles.options} disabled={busy}>
          <legend>Open in the new pane</legend>
          <label className={styles.option} data-selected={mode === 'new' ? 'true' : undefined}>
            <input autoFocus type="radio" name="chat-split-mode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} />
            <Plus aria-hidden="true" />
            <span><strong>New session</strong><small>Start an empty conversation.</small></span>
          </label>
          <label className={styles.option} data-selected={mode === 'fork' ? 'true' : undefined}>
            <input type="radio" name="chat-split-mode" value="fork" checked={mode === 'fork'} disabled={forkReason !== null}
              onChange={() => setMode('fork')} />
            <GitFork aria-hidden="true" />
            <span><strong>Fork current conversation</strong><small>{forkReason ?? 'Copy the conversation so far and continue independently.'}</small></span>
          </label>
        </fieldset>
        {workspace.error && <p role="alert">{workspace.error}</p>}
        {busy && <p role="status">Creating fork…</p>}
        <div className={styles.buttons}>
          <NeumorphicButton size="standard" raised type="button" disabled={busy} onClick={onClose}>Cancel</NeumorphicButton>
          <NeumorphicButton size="standard" raised type="submit" disabled={!canSplit}>{mode === 'fork' ? 'Fork and split' : 'Create and split'}</NeumorphicButton>
        </div>
      </form>
    </Modal>
  );
}
