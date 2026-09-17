export type EvidenceRole = 'official' | 'external' | 'unknown';
export type EvidenceRelation = 'supports' | 'challenges' | 'context';
export interface ResearchQuestion {
  id: string;
  question: string;
  query: string;
  externalQuery: string;
  requireIndependent: boolean;
  requireOfficial?: boolean;
}
export interface ResearchPlan { questions: ResearchQuestion[]; officialDomains: string[] }
export interface ResearchAssessment { questionId: string; sourceId: string; role: EvidenceRole; relation: EvidenceRelation; sufficient: boolean }
export interface ResearchAnswer { questionId: string; status: QuestionStatus; answer: string; sourceIds: string[]; comparison: string; limitations: string }
export interface ResearchReport { answers: ResearchAnswer[] }
export interface ResearchInvestigation {
  plan: ResearchPlan;
  assessments: ResearchAssessment[];
  activeQuestionId: string | null;
  model: string;
  report?: ResearchReport;
}
export type QuestionStatus = 'unconfirmed' | 'partial' | 'answered' | 'conflicting';

export function questionStatus(question: ResearchQuestion, assessments: ResearchAssessment[]): QuestionStatus {
  const evidence = assessments.filter(entry => entry.questionId === question.id);
  if (evidence.some(entry => entry.relation === 'challenges')) return 'conflicting';
  const supporting = evidence.filter(entry => entry.relation === 'supports' && entry.sufficient);
  if (supporting.length && (!question.requireIndependent || supporting.some(entry => entry.role === 'external'))
    && (!question.requireOfficial || supporting.some(entry => entry.role === 'official'))) return 'answered';
  return evidence.length ? 'partial' : 'unconfirmed';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid research structure.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError('Invalid research text.');
  return value.trim();
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError('Invalid research list.');
  return value;
}
function literal<T extends string>(value: unknown, choices: readonly T[]): T {
  const result = choices.find(choice => choice === value);
  if (!result) throw new TypeError('Invalid research choice.');
  return result;
}

export function parseResearchPlan(value: unknown): ResearchPlan {
  const input = record(value);
  const questions = list(input.questions, 4).map((value, index) => {
    const q = record(value);
    if (q.requireIndependent !== true && q.requireIndependent !== false) throw new TypeError('Invalid independence requirement.');
    if (q.requireOfficial !== undefined && q.requireOfficial !== true && q.requireOfficial !== false) throw new TypeError('Invalid official-source requirement.');
    return { id: `q${index + 1}`, question: text(q.question, 500), query: text(q.query, 300),
      externalQuery: text(q.externalQuery, 300), requireIndependent: q.requireIndependent,
      ...(q.requireOfficial === undefined ? {} : { requireOfficial: q.requireOfficial }) };
  });
  if (!questions.length || new Set(questions.map(q => q.question)).size !== questions.length) throw new TypeError('Research needs distinct questions.');
  const officialDomains = list(input.officialDomains, 12).map(value => {
    const domain = text(value, 253).toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new TypeError('Invalid official domain.');
    return domain;
  });
  return { questions, officialDomains: [...new Set(officialDomains)] };
}

/** Conservative grouping: subdomains never become independent publishers. */
export function researchPublisher(url: string, officialDomains: string[]): string {
  const host = new URL(url).hostname.toLowerCase();
  if (officialDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) return 'official';
  return host.split('.').slice(-2).join('.');
}

export function parseResearchReport(value: unknown, plan: ResearchPlan, assessments: ResearchAssessment[]): ResearchReport {
  const answers = list(record(value).answers, 4).map(value => {
    const answer = record(value);
    const questionId = text(answer.questionId, 10);
    const requestedStatus = literal(answer.status, ['answered', 'partial', 'unconfirmed', 'conflicting'] as const);
    const evidence = assessments.filter(entry => entry.questionId === questionId);
    if (!plan.questions.some(q => q.id === questionId)) throw new TypeError('Unknown report question.');
    const sourceIds = list(answer.sourceIds, 10).map(value => text(value, 10));
    if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => !evidence.some(entry => entry.sourceId === id))) {
      throw new TypeError('The report cites evidence not collected for this question.');
    }
    if (evidence.length && !sourceIds.length) throw new TypeError('The report is missing citations.');
    if (evidence.some(entry => entry.relation === 'challenges' && !sourceIds.includes(entry.sourceId))) {
      throw new TypeError('The report omitted conflicting evidence.');
    }
    const prose = { answer: text(answer.answer, 6000), comparison: text(answer.comparison, 3000), limitations: text(answer.limitations, 2000) };
    if (Object.values(prose).some(value => /https?:\/\/|\[[^\]]*\]\(|\[(?:s|q)?\d+\]/i.test(value))) {
      throw new TypeError('Use structured citations only in research reports.');
    }
    const observedStatus = questionStatus(plan.questions.find(q => q.id === questionId)!, assessments);
    const status = observedStatus === 'conflicting' ? 'conflicting'
      : observedStatus === 'unconfirmed' ? 'unconfirmed'
      : requestedStatus === 'answered' ? observedStatus : requestedStatus;
    return { questionId, status, sourceIds, ...(evidence.length ? prose : {
      answer: 'Unconfirmed: no evidence was collected for this question.',
      comparison: 'No collected sources are available to compare.',
      limitations: 'Further research is required before drawing a conclusion.',
    }) };
  });
  if (answers.length !== plan.questions.length || new Set(answers.map(answer => answer.questionId)).size !== answers.length) {
    throw new TypeError('The report must address every research question.');
  }
  return { answers };
}

export function parseResearchInvestigation(value: unknown, sourceIds: string[]): ResearchInvestigation {
  const input = record(value);
  const plan = parseResearchPlan(input.plan);
  const assessments = list(input.assessments, 40).map(value => {
    const entry = record(value);
    const questionId = text(entry.questionId, 10), sourceId = text(entry.sourceId, 10);
    if (!plan.questions.some(q => q.id === questionId) || !sourceIds.includes(sourceId)
      || (entry.sufficient !== true && entry.sufficient !== false)) throw new TypeError('Invalid research evidence mapping.');
    return { questionId, sourceId, sufficient: entry.sufficient,
      role: literal(entry.role, ['official', 'external', 'unknown'] as const),
      relation: literal(entry.relation, ['supports', 'challenges', 'context'] as const) };
  });
  const activeQuestionId = input.activeQuestionId === null ? null : text(input.activeQuestionId, 10);
  if (activeQuestionId && !plan.questions.some(q => q.id === activeQuestionId)) throw new TypeError('Invalid active question.');
  return { plan, assessments, activeQuestionId, model: text(input.model, 128),
    ...(input.report === undefined ? {} : { report: parseResearchReport(input.report, plan, assessments) }) };
}
