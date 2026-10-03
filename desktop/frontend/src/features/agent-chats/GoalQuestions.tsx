import { useState } from 'react';
import type { ChatMember, RoomQuestion } from '../../../../shared/agent-chats';
import { LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import styles from './ChatsView.module.css';

function Question({ question, members, disabled, onChange }: {
  question: RoomQuestion; members: ChatMember[]; disabled: boolean; onChange(id: string, recipient: string | null): void;
}) {
  const [recipient, setRecipient] = useState('');
  const alternatives = members.filter(m => m.id !== question.recipient);
  const selected = alternatives.some(m => m.id === recipient) ? recipient : '';
  return <details>
    <summary>{members.find(m => m.id === question.recipient)?.name ?? question.recipient} · {question.status}</summary>
    <p>{question.text}</p>
    {question.closure && <p>{question.closure}</p>}
    {question.status === 'waiting' && <div className={styles.composerControls}>
      <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => onChange(question.id, null)}>Cancel question</NeumorphicButton>
      <LiquidGlassSelect ariaLabel="New question recipient" value={selected} disabled={disabled || !alternatives.length}
        options={[{ value: '', label: 'Choose another participant' }, ...alternatives.map(m => ({ value: m.id, label: m.name }))]} onChange={setRecipient} />
      <NeumorphicButton variant="standard" disabled={disabled || !selected} onClick={() => onChange(question.id, selected)}>Reassign question</NeumorphicButton>
    </div>}
  </details>;
}
export function GoalQuestions({ questions, members, disabled, onChange }: {
  questions: RoomQuestion[]; members: ChatMember[]; disabled: boolean; onChange(id: string, recipient: string | null): void;
}) {
  if (!questions.length) return null;
  return <div aria-label="Goal questions">
    <p>Questions · {questions.filter(q => q.status === 'waiting').length} waiting</p>
    {questions.map(question => <Question key={question.id} question={question} members={members} disabled={disabled} onChange={onChange} />)}
  </div>;
}
