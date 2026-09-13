import { ChevronRight, Link2, Square, X } from 'lucide-react';
import { useState } from 'react';
import { CHAT_RELAY_MAX_ROUNDS, type ChatRelayMode } from '../../../../shared/chat-relay';
import { LiquidGlassPanel, Modal, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import type { ChatWorkspaceController } from './useChatWorkspace';
import type { ChatController } from './useChatController';
import { MessageContent } from './MessageContent';
import styles from './ChatRelayControls.module.css';

const relayModes: { value: ChatRelayMode; label: string; description: string }[] = [
  { value: 'review', label: 'Review', description: 'A proposes, B reviews, then A revises. Stops after three responses.' },
  { value: 'debate', label: 'Debate', description: 'A and B exchange arguments and counterpoints, then a separate moderator C summarizes the debate.' },
  { value: 'consensus', label: 'Consensus', description: 'Propose, review, and confirm the same version. Stops when both agree or the round limit is reached.' },
];

const relayRoundOptions = Array.from({ length: CHAT_RELAY_MAX_ROUNDS }, (_, index) => index + 1);

interface RelayPane {
  contextId: string;
  threadId: string;
  ready: boolean;
}

function paneFor(contextId: string, controller: ChatController | undefined): RelayPane | null {
  const threadId = controller?.state.activeSessionId;
  if (!controller || !threadId) return null;
  const { state } = controller;
  return {
    contextId, threadId,
    ready: state.phase === 'idle' && !state.pendingNewResponse
      && state.responseThreadIds.length === 0 && state.approvals.length === 0,
  };
}

function ChatRelayDialog({ workspace, source, onClose }: {
  workspace: ChatWorkspaceController;
  source: RelayPane;
  onClose: () => void;
}) {
  const peers = workspace.paneIds.flatMap((id) => {
    const pane = paneFor(id, workspace.controllers[id]);
    return pane && pane.contextId !== source.contextId && pane.threadId !== source.threadId ? [pane] : [];
  });
  const [targetId, setTargetId] = useState(() => peers.find((peer) => peer.ready)?.contextId ?? '');
  const [moderatorId, setModeratorId] = useState('');
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState<ChatRelayMode>('review');
  const [maxRounds, setMaxRounds] = useState(3);
  const roundLimit = mode === 'review' ? 1 : maxRounds;
  const target = peers.find((peer) => peer.contextId === targetId);
  const moderators = peers.filter((peer) => peer.contextId !== target?.contextId && peer.threadId !== target?.threadId);
  const moderator = moderators.find((peer) => peer.contextId === moderatorId);
  const moderatorReady = mode !== 'debate' || moderatorId === '' || moderator?.ready === true;
  const currentSource = paneFor(source.contextId, workspace.controllers[source.contextId]);
  const sourceReady = currentSource?.threadId === source.threadId && currentSource.ready;
  const { relay } = workspace;
  const busy = relay.pending || relay.running;
  const canStart = sourceReady && target?.ready && moderatorReady && objective.trim().length > 0 && !busy;

  const start = async (): Promise<void> => {
    if (!canStart || !target) return;
    const accepted = await relay.start({
      sourceContextId: source.contextId, sourceThreadId: source.threadId,
      targetContextId: target.contextId, targetThreadId: target.threadId,
      objective: objective.trim(), mode, maxRounds: roundLimit,
      ...(mode === 'debate' && moderator ? { moderatorContextId: moderator.contextId, moderatorThreadId: moderator.threadId } : {}),
    });
    if (accepted) onClose();
  };

  return (
    <Modal className={styles.dialog} title="Connect conversations" titleIcon={<Link2 aria-hidden="true" />} onClose={onClose}>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <fieldset className={styles.peers} disabled={busy}>
          <legend className={styles.sectionLabel}>Conversation mode</legend>
          <div className={styles.modeList}>
            {relayModes.map((option) => (
              <label key={option.value} className={`${styles.peer} ${styles.modeOption}`} data-selected={mode === option.value ? 'true' : undefined}>
                <input type="radio" name="relay-mode" value={option.value} checked={mode === option.value}
                  onChange={() => setMode(option.value)} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className={styles.description}>{relayModes.find((option) => option.value === mode)?.description}</p>
        {mode !== 'review' && (
          <fieldset className={styles.peers} disabled={busy}>
            <legend>Maximum rounds</legend>
            <div className={styles.modeList}>
              {relayRoundOptions.map((round) => (
                <label key={round} className={styles.peer} data-selected={maxRounds === round ? 'true' : undefined}>
                  <input type="radio" name="relay-rounds" value={round} checked={maxRounds === round}
                    onChange={() => setMaxRounds(round)} />
                  <span>{round}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {mode !== 'review' && <p className={styles.description}>{mode === 'debate' ? 'Two responses per round, followed by one summary from C. Debate completion does not mean agreement.' : 'Up to three responses per round. Agreement is not guaranteed.'}</p>}
        <div className={styles.field}>
          <strong>{mode === 'review' ? 'A · Proposal and revision' : 'A · First participant'}</strong>
          <span className={styles.thread}>{source.threadId}</span>
        </div>
        <fieldset className={styles.peers} disabled={busy}>
          <legend>{mode === 'review' ? 'B · Reviewer' : 'B · Second participant'}</legend>
          <div className={styles.peerList}>
            {peers.map((peer) => (
              <label className={styles.peer} key={peer.contextId} data-selected={targetId === peer.contextId ? 'true' : undefined}>
                <input type="radio" name="relay-peer" value={peer.contextId} checked={targetId === peer.contextId}
                  disabled={!peer.ready} onChange={() => {
                    setTargetId(peer.contextId);
                    if (moderator?.threadId === peer.threadId) setModeratorId('');
                  }} />
                <span className={styles.thread}>{peer.threadId}{!peer.ready && <small>Response in progress</small>}</span>
              </label>
            ))}
          </div>
          {peers.length === 0 && <p className={styles.description}>Open another pane and send its first message to create a thread.</p>}
        </fieldset>
        {mode === 'debate' && <fieldset className={styles.peers} disabled={busy}>
          <legend>C · Moderator</legend>
          <div className={styles.peerList}>
            <label className={styles.peer} data-selected={moderatorId === '' ? 'true' : undefined}>
              <input type="radio" name="relay-moderator" value="" checked={moderatorId === ''} onChange={() => setModeratorId('')} />
              <span>New dedicated session<small>Uses A’s model settings. Created automatically without adding a chat pane.</small></span>
            </label>
            {moderators.map((peer) => <label className={styles.peer} key={peer.contextId}
              data-selected={moderatorId === peer.contextId ? 'true' : undefined}>
              <input type="radio" name="relay-moderator" value={peer.contextId} checked={moderatorId === peer.contextId}
                disabled={!peer.ready} onChange={() => setModeratorId(peer.contextId)} />
              <span className={styles.thread}>{peer.threadId}{!peer.ready && <small>Response in progress</small>}</span>
            </label>)}
          </div>
        </fieldset>}
        {mode === 'debate' && <p className={styles.description}>C receives the full A/B debate and separates common ground, remaining differences, supporting evidence, and further validation. C’s recommendations do not establish agreement between A and B.</p>}
        <label className={styles.field}>
          <strong>What should they work on?</strong>
          <NeumorphicTextField multiline autoFocus rows={3} maxLength={8000} value={objective} disabled={busy}
            placeholder="Describe the question or proposal to discuss…" onChange={(event) => setObjective(event.target.value)} />
        </label>
        <p className={styles.description}>Each response is shared with the other conversation. Existing model and permission settings apply.</p>
        {!sourceReady && <p role="status">The source thread changed or is busy. Reopen this dialog when it is ready.</p>}
        {!moderatorReady && <p role="status">The moderator is unavailable. Choose a ready session or create a new dedicated session.</p>}
        {relay.error && <p role="alert">{relay.error}</p>}
        <div className={styles.buttons}>
          <NeumorphicButton size="standard" raised onClick={onClose}>Cancel</NeumorphicButton>
          <NeumorphicButton size="standard" raised type="submit" disabled={!canStart}>{relay.pending ? 'Connecting…' : 'Start conversation'}</NeumorphicButton>
        </div>
      </form>
    </Modal>
  );
}

export function ChatRelayButton({ workspace, className }: { workspace: ChatWorkspaceController; className: string }) {
  const [source, setSource] = useState<RelayPane | null>(null);
  const pane = paneFor(workspace.activePaneId, workspace.activeController ?? undefined);
  const disabled = !pane?.ready || workspace.relay.running || workspace.relay.pending;
  return (
    <>
      <NeumorphicButton raised className={`${className} ${styles.trigger}`} aria-label="Connect conversations" title={pane ? 'Connect conversations' : 'Send a message to create a thread before connecting'}
        disabled={disabled} onClick={() => { workspace.relay.dismissError(); setSource(pane); }}>
        <Link2 aria-hidden="true" />
      </NeumorphicButton>
      {source && <ChatRelayDialog workspace={workspace} source={source} onClose={() => setSource(null)} />}
    </>
  );
}

export function ChatRelayStatus({ workspace }: { workspace: ChatWorkspaceController }) {
  const { relay } = workspace;
  const state = relay.displayedState;
  const showingLive = !relay.selectedResult && state?.id === relay.state?.id;
  if (!state && !relay.error) return null;
  const phaseLabels = { proposal: 'proposing', review: 'reviewing', revision: 'revising', discussion: 'discussing', confirmation: 'confirming', synthesis: 'summarizing' };
  const stepLabel = state ? `${state.speaker} ${phaseLabels[state.phase]}` : '';
  const completionLabels = { reviewed: 'Review completed', debated: 'Debate completed', agreed: 'Agreement reached', limit: 'Round limit reached · No agreement' };
  const completedLabel = state?.outcome ? completionLabels[state.outcome] : 'Conversation completed';
  const label = state?.status === 'completed' ? completedLabel
    : state?.status === 'stopping' ? 'Stopping conversation…'
    : state?.status === 'stopped' ? 'Conversation stopped'
      : state?.status === 'error' ? 'Conversation failed' : stepLabel;
  return (
    <LiquidGlassPanel className={styles.status} data-liquid-glass-backdrop="true">
      <header className={styles.statusMain}>
        <div className={styles.statusCopy} role="status" aria-live="polite">
          <Link2 aria-hidden="true" />
          <span>{state && label}</span>
          {state && <span className={styles.badge}>{state.mode === 'review' ? `${state.step}/3` : `Round ${state.round}/${state.maxRounds}`}</span>}
          {state && <span className={styles.participants}>{relayModes.find((option) => option.value === state.mode)?.label}</span>}
          {state?.proposalVersion != null && <span className={styles.participants}>Proposal v{state.proposalVersion}</span>}
          {state && <span className={styles.participants} title={`A · ${state.sourceThreadId} ↔ B · ${state.targetThreadId}${state.moderatorThreadId ? ` → C · ${state.moderatorThreadId}` : ''}`}>
            A · {state.sourceThreadId.slice(0, 8)}…{state.sourceThreadId.slice(-4)} ↔ B · {state.targetThreadId.slice(0, 8)}…{state.targetThreadId.slice(-4)}
            {state.moderatorThreadId && <> → C · {state.moderatorThreadId.slice(0, 8)}…{state.moderatorThreadId.slice(-4)}</>}
          </span>}
          {(relay.error || state?.historyError || state?.message) && <span title={relay.error ?? state?.historyError ?? state?.message ?? undefined}>{relay.error ?? state?.historyError ?? state?.message}</span>}
        </div>
        {relay.running && showingLive ? (
          <NeumorphicButton raised className={styles.stop} disabled={relay.pending || state?.status === 'stopping'} onClick={() => void relay.stop()}>
            <Square aria-hidden="true" />{relay.pending || state?.status === 'stopping' ? 'Stopping…' : 'Stop all'}
          </NeumorphicButton>
        ) : (
          <NeumorphicButton raised className="theme-toggle" aria-label="Dismiss conversation status"
            onClick={() => { relay.dismissResult(); relay.dismissError(); }}><X size={11} strokeWidth={1.7} aria-hidden="true" /></NeumorphicButton>
        )}
      </header>
      {relay.selectedResult && <div className={styles.savedObjective}>{relay.selectedResult.objective}</div>}
      {relay.running && !showingLive && <div className={styles.liveNotice}>
        <span>A conversation is running.</span>
        <NeumorphicButton raised onClick={relay.showLiveResult}>Show current conversation</NeumorphicButton>
      </div>}
      {state && (state.issues.length > 0 || state.proposal || state.summary) && (
        <details className={styles.result} open={state.status !== 'running' && state.status !== 'stopping' || undefined}>
          <summary><ChevronRight aria-hidden="true" />{state.outcome === 'agreed' ? 'Agreed proposal' : state.mode === 'debate' ? (state.moderatorThreadId ? 'Moderator summary and remaining differences' : 'Final review and remaining differences') : 'Proposal and open issues'}
            {state.issues.length > 0 && <span className={styles.badge}>{state.issues.length}</span>}
          </summary>
          <div className={styles.resultBody}>
            {state.summary && <div><MessageContent text={state.summary} /></div>}
            {state.proposal && <div><strong className={styles.resultHeading}>{state.outcome === 'agreed' ? 'Agreed proposal' : 'Current proposal'}</strong><MessageContent text={state.proposal} /></div>}
            {state.issues.length > 0 && <div><strong className={styles.resultHeading}>Open issues</strong><ul className={styles.resultIssues}>{state.issues.map((issue, index) => <li key={index}><MessageContent text={issue} /></li>)}</ul></div>}
          </div>
        </details>
      )}
    </LiquidGlassPanel>
  );
}
