import { createContext, useContext, useRef, useState } from 'react';
import type { ChatAsyncQuestion } from '../../../../shared/chat-async-question';
import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import { ChatQuestionFields } from './ChatUserInputFields';
import type { ChatSendResult } from './chatDraftRecovery';
import type { InputDraft } from './chatUserInputForm';
import styles from './ChatUserInputPrompt.module.css';

export const ChatAsyncQuestionContext = createContext<{
  disabled: boolean;
  send: (text: string) => Promise<ChatSendResult>;
  answers?: ReadonlyMap<string, InputDraft>;
} | null>(null);

export function asyncQuestionAnswerText(questions: ChatAsyncQuestion[], draft: InputDraft): string {
  return questions.map((question, index) => {
    const answer = draft[String(index)];
    if (typeof answer !== 'string' || !answer.trim()) throw new Error(`Answer ${question.title}`);
    return `${question.title}\n${answer.trim()}`;
  }).join('\n\n');
}

export function ChatAsyncQuestions({ questions, itemId }: { questions: ChatAsyncQuestion[]; itemId?: string }) {
  const context = useContext(ChatAsyncQuestionContext);
  const savedAnswers = itemId ? context?.answers?.get(itemId) : undefined;
  const [draft, setDraft] = useState<InputDraft>(() => Object.fromEntries(
    questions.map((question, index) => [String(index), question.options?.[0] ?? '']),
  ));
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const completed = sent || savedAnswers !== undefined;
  const disabled = !context || context.disabled || pending || completed;
  const submit = async () => {
    if (disabled || sending.current) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await context.send(asyncQuestionAnswerText(questions, draft));
      if (result.status === 'accepted') setSent(true);
      else setError(result.message ?? 'Your answer was not sent. Try again.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  return <LiquidGlassPanel as="section" className={`${styles.panel} ${styles.compactPanel}`} aria-label="Answer assistant questions">
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset className={styles.question} disabled={disabled}>
        <div className={styles.fields}>
          <ChatQuestionFields compact questions={questions.map((question, index) => ({
            id: String(index), header: '', question: question.title, isOther: true, isSecret: false,
            options: question.options?.map((label) => ({ label, description: '' })) ?? null,
          }))} draft={savedAnswers ?? draft} onChange={(name, value) => setDraft((current) => ({ ...current, [name]: value }))} />
        </div>
        <div className={styles.actions}>
          <NeumorphicButton raised size="standard" type="submit" disabled={disabled}>
            {completed ? 'Answer sent' : pending ? 'Sending…' : 'Submit answers'}
          </NeumorphicButton>
        </div>
      </fieldset>
      {error && !completed && <p className={styles.error} role="alert">{error}</p>}
      {completed && <p className={styles.message} role="status">Your answer was sent.</p>}
    </form>
  </LiquidGlassPanel>;
}
