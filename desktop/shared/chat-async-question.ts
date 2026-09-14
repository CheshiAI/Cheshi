export interface ChatAsyncQuestion {
  title: string;
  options: string[] | null;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeChatAsyncQuestions(value: unknown): ChatAsyncQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: ChatAsyncQuestion[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const question = entry as Record<string, unknown>;
    if (!nonemptyString(question.title)) continue;
    if (question.options === null) {
      questions.push({ title: question.title, options: null });
    } else if (Array.isArray(question.options) && question.options.every(nonemptyString)) {
      questions.push({ title: question.title, options: [...question.options] });
    }
  }
  return questions;
}
