import type { ChatAsyncQuestion } from '../../../../shared/chat-async-question';
import type { InputDraft } from './chatUserInputForm';
import type { ChatTimelineItem } from './model';

/** Read the same title/answer blocks that the question form sends to the conversation. */
function readAnswers(questions: ChatAsyncQuestion[], text: string): InputDraft | null {
  const answers: InputDraft = {};
  let offset = 0;
  for (const [index, question] of questions.entries()) {
    const prefix = `${question.title}\n`;
    if (!text.startsWith(prefix, offset)) return null;
    const start = offset + prefix.length;
    const next = questions[index + 1];
    const end = next ? text.indexOf(`\n\n${next.title}\n`, start) : text.length;
    if (end < 0) return null;
    const answer = text.slice(start, end);
    if (!answer.trim() || answer !== answer.trim()) return null;
    answers[String(index)] = answer;
    offset = end + 2;
  }
  return answers;
}

/** Derive completion from this thread's durable history, including older submitted cards. */
export function completedAsyncQuestionAnswers(items: readonly ChatTimelineItem[]): ReadonlyMap<string, InputDraft> {
  const completed = new Map<string, InputDraft>();
  const waiting: Array<{ id: string; questions: ChatAsyncQuestion[] }> = [];
  for (const item of items) {
    if (item.kind === 'assistant' && item.questions?.length) {
      waiting.push({ id: item.id, questions: item.questions });
    } else if (item.kind === 'user' && !item.pending && !item.delivery) {
      // A single reply completes only the most recent matching unanswered card.
      for (let index = waiting.length - 1; index >= 0; index--) {
        const card = waiting[index];
        if (!card) continue;
        const answers = readAnswers(card.questions, item.text);
        if (!answers) continue;
        completed.set(card.id, answers);
        waiting.splice(index, 1);
        break;
      }
    }
  }
  return completed;
}
