import { inputRecord } from './chat-user-input.ts';

export type ChatAsyncQuestion = { title: string; options: string[] | null };

/** Preserve structured async questions; never infer them from message wording. */
export function normalizeAsyncQuestions(value: unknown): ChatAsyncQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const questions: ChatAsyncQuestion[] = [];
  for (const entry of value) {
    const question = inputRecord(entry);
    if (!question || typeof question.title !== 'string' || !question.title.trim()) return null;
    const options = question.options;
    if (options != null && (!Array.isArray(options)
      || options.some(option => typeof option !== 'string' || !option.trim()))) return null;
    questions.push({ title: question.title, options: options == null ? null : [...options] });
  }
  return questions;
}

export function asyncQuestionsFromMessage(value: unknown): ChatAsyncQuestion[] | null {
  const message = inputRecord(value);
  return message?.delivery === 'async' ? normalizeAsyncQuestions(message.questions) : null;
}
