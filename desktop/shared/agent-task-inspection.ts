import { normalizeHistoryRecallActivity, type HistoryRecallActivity } from './history-recall.ts';
import { parseQuestionDeadline } from './agent-question.ts';

export interface TaskCriterion { criterion: string; met: boolean; evidence: string }
export interface TaskDecision {
  action: 'continue' | 'wait' | 'blocked' | 'complete'; reason: string; progress: string; nextAction: string; criteria: TaskCriterion[];
}
export interface TaskGoal {
  phase: string; turns: number; verificationRequired: boolean; criteria: TaskCriterion[]; decisions: TaskDecision[]; pending: TaskDecision | null;
}
export interface TaskEvidence { id: string; kind: 'file' | 'command'; detail: string; output: string; exitCode: number | null; successful: boolean | null }
export interface TaskVerification {
  verdicts: { criterion: string; verdict: 'pass' | 'fail' | 'inconclusive'; reason: string; evidenceIds: string[] }[];
  evidence: TaskEvidence[];
}
export interface TaskVerificationRequest { goal: string; criteria: string[]; artifacts: { path: string; sha256: string }[] }
export interface TaskMessage {
  expiresAt?: string | null; closureReason?: 'expired';
  id: string; kind: 'question' | 'question_closed' | 'reply' | 'verification_request' | 'verification_result';
  from: string; to: string; fromName: string; toName: string; questionId: string; text: string;
  delivery: 'queued' | 'delivered' | 'received' | 'processed';
  verification: TaskVerification | null; request: TaskVerificationRequest | null;
}
export interface TaskRecall { id: string; activity: HistoryRecallActivity }
export interface TaskInspection {
  recoveryRoomId?: string;
  finishedAt: string | null; threadId: string | null; conversation: string | null;
  goal: TaskGoal | null; messages: TaskMessage[]; evidence: TaskEvidence[];
  recall: TaskRecall[] | null; error: string | null;
}
export function inspectionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid task detail.');
  return value as Record<string, unknown>;
}
export function inspectionText(value: unknown, limit = 4000): string {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError('Invalid task detail text.');
  return value;
}
export function inspectionList<T>(value: unknown, parse: (value: unknown) => T, max = 100): T[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError('Invalid task detail list.');
  return value.map(parse);
}
const nullableText = (value: unknown) => value === null || value === undefined ? null : inspectionText(value);
const flag = (value: unknown): boolean => {
  if (value !== true && value !== false) throw new TypeError('Invalid task detail flag.');
  return value;
};
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new TypeError('Invalid task detail state.');
  return value as T;
}
function criterion(value: unknown): TaskCriterion {
  const v = inspectionRecord(value);
  return { criterion: inspectionText(v.criterion), met: flag(v.met), evidence: inspectionText(v.evidence) };
}
function decision(value: unknown): TaskDecision {
  const v = inspectionRecord(value);
  return { action: choice(v.action, ['continue', 'wait', 'blocked', 'complete']), reason: inspectionText(v.reason),
    progress: inspectionText(v.progress), nextAction: inspectionText(v.nextAction), criteria: inspectionList(v.criteria, criterion, 16) };
}
export function parseTaskGoal(value: unknown): TaskGoal {
  const v = inspectionRecord(value);
  if (!Number.isSafeInteger(v.turns) || Number(v.turns) < 0 || Number(v.turns) > 1000) throw new TypeError('Invalid goal turns.');
  return { phase: choice(v.phase, ['active', 'ready', 'waiting', 'blocked', 'completed']), turns: Number(v.turns),
    verificationRequired: v.verificationRequired === undefined ? false : flag(v.verificationRequired),
    criteria: inspectionList(v.criteria, criterion, 16), decisions: inspectionList(v.decisions, decision, 1000),
    pending: v.pending === null ? null : decision(v.pending) };
}
export function parseTaskEvidence(value: unknown): TaskEvidence {
  const v = inspectionRecord(value);
  if (v.exitCode !== null && !Number.isSafeInteger(v.exitCode)) throw new TypeError('Invalid command exit code.');
  return { id: inspectionText(v.id, 200), kind: choice(v.kind, ['file', 'command']), detail: inspectionText(v.detail, 1000),
    output: inspectionText(v.output, 1000), exitCode: v.exitCode as number | null,
    successful: v.successful === undefined || v.successful === null ? null : flag(v.successful) };
}
export function parseTaskVerification(value: unknown): TaskVerification {
  const v = inspectionRecord(value);
  return { evidence: inspectionList(v.evidence, parseTaskEvidence, 32), verdicts: inspectionList(v.verdicts, raw => {
    const item = inspectionRecord(raw);
    return { criterion: inspectionText(item.criterion), verdict: choice(item.verdict, ['pass', 'fail', 'inconclusive']),
      reason: inspectionText(item.reason), evidenceIds: inspectionList(item.evidenceIds, id => inspectionText(id, 200), 32) };
  }, 16) };
}
export function parseTaskVerificationRequest(value: unknown): TaskVerificationRequest {
  const v = inspectionRecord(value);
  return { goal: inspectionText(v.goal, 20_000), criteria: inspectionList(v.criteria, c => inspectionText(c), 16),
    artifacts: inspectionList(v.artifacts, raw => {
      const a = inspectionRecord(raw), sha256 = inspectionText(a.sha256, 64);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('Invalid artifact digest.');
      return { path: inspectionText(a.path, 300), sha256 };
    }, 16) };
}
export function parseTaskInspection(value: unknown): TaskInspection {
  const v = inspectionRecord(value);
  if (v.recoveryRoomId !== undefined && (typeof v.recoveryRoomId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v.recoveryRoomId))) throw new TypeError('Invalid recovery room.');
  return { finishedAt: nullableText(v.finishedAt), threadId: nullableText(v.threadId), conversation: nullableText(v.conversation),
    ...(v.recoveryRoomId === undefined ? {} : { recoveryRoomId: v.recoveryRoomId as string }),
    error: nullableText(v.error), goal: v.goal === null ? null : parseTaskGoal(v.goal),
    evidence: inspectionList(v.evidence, parseTaskEvidence, 32),
    messages: inspectionList(v.messages, raw => {
      const m = inspectionRecord(raw);
      if (m.closureReason !== undefined && (m.kind !== 'question_closed' || m.closureReason !== 'expired')) throw new TypeError('Invalid question closure reason.');
      return { id: inspectionText(m.id, 200), kind: choice(m.kind, ['question', 'question_closed', 'reply', 'verification_request', 'verification_result']),
        ...(m.expiresAt === undefined ? {} : { expiresAt: parseQuestionDeadline(m.expiresAt) }),
        ...(m.closureReason === 'expired' ? { closureReason: 'expired' as const } : {}),
        from: inspectionText(m.from, 200), to: inspectionText(m.to, 200), fromName: inspectionText(m.fromName, 200), toName: inspectionText(m.toName, 200),
        questionId: inspectionText(m.questionId, 200), text: inspectionText(m.text, 12_000),
        delivery: choice(m.delivery, ['queued', 'delivered', 'received', 'processed']),
        request: m.request === null ? null : parseTaskVerificationRequest(m.request),
        verification: m.verification === null ? null : parseTaskVerification(m.verification) };
    }, 128),
    recall: v.recall === null ? null : inspectionList(v.recall, raw => {
      const r = inspectionRecord(raw), activity = normalizeHistoryRecallActivity(r.activity);
      if (!activity) throw new TypeError('Invalid recall detail.');
      return { id: inspectionText(r.id, 200), activity };
    }, 64) };
}
