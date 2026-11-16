import { useRef, useState } from 'react';
import type { AgentRoom, ChatsRequest, RoomMessage } from '../../../../shared/agent-chats';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import { NeumorphicButton } from '../../shared/ui';
import { GoalQuestions } from './GoalQuestions';
import styles from './ChatsView.module.css';

export function RoomWorkState({ message, room, agents, mutate }: {
  message: RoomMessage; room: AgentRoom; agents: SpecialistAgent[]; mutate(request: ChatsRequest): Promise<void>;
}) {
  const progress = message.goalProgress, integration = progress?.integration ?? message.inspection?.integration;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  async function perform(request: ChatsRequest) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await mutate(request); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update this work.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className={styles.records}>
    {message.relatedTask && message.executionStatus === 'unknown' && message.inspection?.recoveryRoomId === room.id && <div>
      <p>Execution outcome is unknown. Check the saved result before continuing.</p>
      <NeumorphicButton variant="standard" disabled={busy} onClick={() => void perform({ action: 'recover', roomId: room.id, goalId: message.id })}>Check execution result</NeumorphicButton>
    </div>}
    {progress && <section aria-label="Work actions">
      {(message.status === 'unknown' || progress.phase === 'unknown') && <NeumorphicButton variant="standard" disabled={busy}
        onClick={() => void perform({ action: 'recover', roomId: room.id, goalId: message.id })}>Check execution result</NeumorphicButton>}
      {!!progress.questions?.length && <GoalQuestions questions={progress.questions}
        members={room.members.filter(m => m.id !== message.recipient && agents.some(a => a.id === m.id && a.accountId === m.accountId))}
        disabled={busy || progress.phase !== 'waiting' || !!progress.resumeBlocked}
        onChange={(questionId, recipient) => void perform({ action: 'question', roomId: room.id, goalId: message.id, questionId, recipient })}
        onDeadline={(questionId, expiresAt) => void perform({ action: 'question-deadline', roomId: room.id, goalId: message.id, questionId, expiresAt })} />}
    </section>}
    {integration && (integration.issues.length > 0 || integration.application?.status !== 'applied' && integration.application) && <section aria-label="Application attention">
      {integration.issues.map((issue, index) => <p key={index}>Integration conflict · {issue.path ?? 'Candidate'}</p>)}
      {integration.application && <p>Application · {integration.application.status}</p>}
      {integration.application && message.sender === 'user' && integration.candidateHash && <NeumorphicButton variant="standard"
        disabled={busy || !['completed', 'blocked', 'interrupted', 'failed'].includes(message.status ?? '')}
        onClick={() => void perform({ action: 'application-inspect', roomId: room.id, goalId: message.id,
          candidateId: integration.id, hash: integration.candidateHash! })}>Inspect application</NeumorphicButton>}
    </section>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
