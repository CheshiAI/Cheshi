import { useRef, useState } from 'react';
import type { RoomMessage, ChatsRequest } from '../../../../shared/agent-chats';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './ChatsView.module.css';

export function UserQuestions({ message, onAnswer }: { message: RoomMessage; onAnswer(request: ChatsRequest): Promise<void> }) {
  return <>{message.dialogue?.questions.map(question => <UserQuestion key={question.id} message={message} question={question} onAnswer={onAnswer} />)}</>;
}
function UserQuestion({ message, question, onAnswer }: {
  message: RoomMessage; question: NonNullable<RoomMessage['dialogue']>['questions'][number]; onAnswer(request: ChatsRequest): Promise<void>;
}) {
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef<{ text: string; id: string } | null>(null), sending = useRef(false);
  async function answer() {
    const value = text.trim();
    if (!value || sending.current) return;
    if (pending.current?.text !== value) pending.current = { text: value, id: crypto.randomUUID() };
    sending.current = true; setBusy(true); setError(null);
    try {
      await onAnswer({ action: 'send', id: pending.current.id, roomId: message.roomId, threadId: message.kind === 'goal' ? message.id : message.threadId,
        recipient: message.recipient, text: value, goal: false, automatic: true, answerTo: message.id, questionId: question.id });
      setSaved(true);
      // Retain the receipt until the worker acknowledges the answer, including a lost host reply.
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the answer.'); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section aria-label="Question for you">
    <strong>Decision needed</strong><p className={styles.text}>{question.text}</p>
    {question.answer ? <p className={styles.text}>Your answer: {question.answer.text}</p> : <form onSubmit={e => { e.preventDefault(); void answer(); }}>
      <NeumorphicTextField aria-label={`Answer: ${question.text}`} value={text} maxLength={16000} onChange={e => setText(e.target.value)} disabled={busy || saved} />
      <NeumorphicButton variant="standard" type="submit" disabled={busy || saved || !text.trim() || message.status === 'completed' || message.status === 'unknown'}>{busy ? 'Saving…' : saved ? 'Answer queued' : 'Send answer'}</NeumorphicButton>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
