import { skillFlowRequestBody, type SkillFlowQuestion } from './skill-flow-judge.mts';
import { SkillFlowValidationError } from './skill-flow-runtime.mts';

export function fitsSkillFlowQuestion(question: SkillFlowQuestion): boolean {
  try { skillFlowRequestBody(question); return true; }
  catch { return false; }
}

/** Keep every sentence and the entire evidence in each question. Never silently truncate a claim or its sources. */
export function sentenceQuestions(value: string, question: (passage: string) => SkillFlowQuestion): SkillFlowQuestion[] {
  if (fitsSkillFlowQuestion(question(value))) return [question(value)];
  const questions: SkillFlowQuestion[] = [];
  let passage = '';
  for (const { segment } of new Intl.Segmenter('ko', { granularity: 'sentence' }).segment(value)) {
    if (!fitsSkillFlowQuestion(question(segment))) throw new SkillFlowValidationError();
    if (passage && !fitsSkillFlowQuestion(question(passage + segment))) {
      questions.push(question(passage));
      passage = '';
    }
    passage += segment;
  }
  if (passage) questions.push(question(passage));
  if (!questions.length) throw new SkillFlowValidationError();
  return questions;
}
