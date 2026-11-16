import { useEffect, useState } from 'react';
import type { ChatMember, RoomQuestion } from '../../../../shared/agent-chats';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './ChatsView.module.css';

interface QuestionControls {
  members: ChatMember[]; disabled: boolean;
  onChange(id: string, recipient: string | null): void;
  onDeadline(id: string, expiresAt: string | null): void;
}
function localDeadline(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function Question({ question, members, disabled, onChange, onDeadline }: QuestionControls & { question: RoomQuestion }) {
  const [recipient, setRecipient] = useState('');
  const [deadline, setDeadline] = useState(() => localDeadline(question.expiresAt));
  useEffect(() => { setDeadline(localDeadline(question.expiresAt)); }, [question.expiresAt]);
  const timestamp = deadline ? new Date(deadline).getTime() : NaN;
  const validDeadline = Number.isFinite(timestamp) && timestamp > Date.now() && localDeadline(new Date(timestamp).toISOString()) === deadline;
  const alternatives = members.filter(m => m.id !== question.recipient);
  const selected = alternatives.some(m => m.id === recipient) ? recipient : '';
  return <details>
    <summary>{members.find(m => m.id === question.recipient)?.name ?? question.recipient} · {question.status}</summary>
    <p>{question.text}</p>
    {question.closure && <p>{question.closure}</p>}
    <p>Deadline: {question.expiresAt ? new Date(question.expiresAt).toLocaleString() : 'No expiry'}</p>
    {question.status === 'waiting' && <>
    <div className={styles.composerControls}>
      <label>Question deadline (local time)<NeumorphicTextField variant="standard" type="datetime-local" aria-label="Question deadline" value={deadline}
        disabled={disabled} onChange={event => setDeadline(event.target.value)} /></label>
      <NeumorphicButton variant="standard" disabled={disabled || !validDeadline} onClick={() => onDeadline(question.id, new Date(timestamp).toISOString())}>Save deadline</NeumorphicButton>
      <NeumorphicButton variant="ghost" disabled={disabled || !question.expiresAt} onClick={() => onDeadline(question.id, null)}>Remove deadline</NeumorphicButton>
    </div>
    <p>Answers must reach the goal owner before the deadline. Late replies are kept without resuming this goal.</p>
    <div className={styles.composerControls}>
      <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => onChange(question.id, null)}>Cancel question</NeumorphicButton>
      <LiquidGlassSelect ariaLabel="New question recipient" value={selected} disabled={disabled || !alternatives.length}
        options={[{ value: '', label: 'Choose another participant' }, ...alternatives.map(m => ({ value: m.id, label: m.name }))]} onChange={setRecipient} />
      <NeumorphicButton variant="standard" disabled={disabled || !selected} onClick={() => onChange(question.id, selected)}>Reassign question</NeumorphicButton>
    </div></>}
  </details>;
}
export function GoalQuestions({ questions, ...controls }: QuestionControls & { questions: RoomQuestion[] }) {
  if (!questions.length) return null;
  return <div aria-label="Goal questions">
    <p>Questions · {questions.filter(q => q.status === 'waiting').length} waiting</p>
    {questions.map(question => <Question key={question.id} question={question} {...controls} />)}
  </div>;
}
