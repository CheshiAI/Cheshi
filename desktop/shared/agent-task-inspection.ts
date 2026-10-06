import { parsePermissionRequest, type PermissionRequest } from '../../experiments/codex-specialists/src/execution-permissions.ts';
import { parseTaskActivities, type TaskActivity } from './agent-activity.ts';
import { parseConversation, type ConversationState } from '../../experiments/codex-specialists/src/conversation-contract.ts';
import { collaborationTextLimit, WORK_KINDS, parseWorkRequest, parseWorkDraft, type WorkKind, type WorkRequest, type WorkDraft } from './agent-work.ts';
import { candidateReference, type CandidateReference } from '../../experiments/codex-specialists/src/candidate-verification-contract.ts';
import { parseIntegration, type IntegrationSummary } from './agent-work.ts';
import { normalizeHistoryRecallActivity, type HistoryRecallActivity } from './history-recall.ts';
import { parseQuestionDeadline } from './agent-question.ts';

export interface TaskCriterion { criterion: string; met: boolean; evidence: string }
export interface TaskDecision {
  action: 'continue' | 'wait' | 'blocked' | 'complete'; reason: string; progress: string; nextAction: string; criteria: TaskCriterion[];
}
export interface TaskGoalUsage { reportedThroughTurn: number; inputTokens: number; outputTokens: number; totalTokens: number }
export function parseGoalUsage(value: unknown): TaskGoalUsage {
  const v = inspectionRecord(value);
  if (![v.reportedThroughTurn, v.inputTokens, v.outputTokens, v.totalTokens].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) throw new TypeError('Invalid goal usage.');
  return { reportedThroughTurn: Number(v.reportedThroughTurn), inputTokens: Number(v.inputTokens), outputTokens: Number(v.outputTokens), totalTokens: Number(v.totalTokens) };
}
export interface TaskGoal {
  usage?: TaskGoalUsage;
  phase: string; turns: number; verificationRequired: boolean; criteria: TaskCriterion[]; decisions: TaskDecision[]; pending: TaskDecision | null;
}
export interface TaskEvidence { id: string; kind: 'file' | 'command'; detail: string; output: string; exitCode: number | null; successful: boolean | null }
export interface TaskVerification {
  candidate?: CandidateReference;
  verdicts: { criterion: string; verdict: 'pass' | 'fail' | 'inconclusive'; reason: string; evidenceIds: string[] }[];
  evidence: TaskEvidence[];
}
export interface TaskVerificationRequest { candidate?: CandidateReference; goal: string; criteria: string[]; artifacts: { path: string; sha256: string | null }[] }
export interface TaskMessage {
  expiresAt?: string | null; closureReason?: 'expired';
  id: string; kind: WorkKind | 'question' | 'question_closed' | 'reply' | 'verification_request' | 'verification_result';
  from: string; to: string; fromName: string; toName: string; questionId: string; text: string;
  delivery: 'queued' | 'delivered' | 'received' | 'processed';
  verification: TaskVerification | null; request: TaskVerificationRequest | null;
}
export interface TaskRecall { id: string; activity: HistoryRecallActivity }
export interface TaskInspection {
  permissionRequest?: PermissionRequest;
  activity?: TaskActivity[]; activityTruncated?: boolean;
  dialogue?: ConversationState;
  integration?: IntegrationSummary;
  recoveryRoomId?: string;
  recoveryKind?: 'consultation' | 'verification' | 'delegation';
  work?: { request: WorkRequest; draft: WorkDraft | null };
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
  if (!Number.isSafeInteger(v.turns) || Number(v.turns) < 0) throw new TypeError('Invalid goal turns.');
  return { phase: choice(v.phase, ['active', 'ready', 'waiting', 'blocked', 'completed']), turns: Number(v.turns),
    ...(v.usage === undefined ? {} : { usage: parseGoalUsage(v.usage) }),
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
  return { ...(v.candidate === undefined ? {} : { candidate: candidateReference(v.candidate) }), evidence: inspectionList(v.evidence, parseTaskEvidence, 64), verdicts: inspectionList(v.verdicts, raw => {
    const item = inspectionRecord(raw);
    return { criterion: inspectionText(item.criterion), verdict: choice(item.verdict, ['pass', 'fail', 'inconclusive']),
      reason: inspectionText(item.reason), evidenceIds: inspectionList(item.evidenceIds, id => inspectionText(id, 200), 32) };
  }, 16) };
}
export function parseTaskVerificationRequest(value: unknown): TaskVerificationRequest {
  const v = inspectionRecord(value);
  const candidate = v.candidate === undefined ? undefined : candidateReference(v.candidate);
  return { ...(candidate ? { candidate } : {}), goal: inspectionText(v.goal, 20_000), criteria: inspectionList(v.criteria, c => inspectionText(c), 16),
    artifacts: inspectionList(v.artifacts, raw => {
      const a = inspectionRecord(raw), sha256 = candidate && a.sha256 === null ? null : inspectionText(a.sha256, 64);
      if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('Invalid artifact digest.');
      return { path: inspectionText(a.path, 300), sha256 };
    }, candidate ? 32 : 16) };
}
export function parseTaskInspection(value: unknown): TaskInspection {
  const v = inspectionRecord(value);
  if (v.recoveryRoomId !== undefined && (typeof v.recoveryRoomId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v.recoveryRoomId))) throw new TypeError('Invalid recovery room.');
  return { ...(v.permissionRequest === undefined ? {} : { permissionRequest: parsePermissionRequest(v.permissionRequest) }),
    ...(v.activity === undefined ? {} : { activity: parseTaskActivities(v.activity), activityTruncated: v.activityTruncated === true }), ...(v.dialogue === undefined ? {} : { dialogue: parseConversation(v.dialogue) }), finishedAt: nullableText(v.finishedAt), threadId: nullableText(v.threadId), conversation: nullableText(v.conversation),
    ...(v.integration === undefined ? {} : { integration: parseIntegration(v.integration) }),
    ...(v.recoveryRoomId === undefined ? {} : { recoveryRoomId: v.recoveryRoomId as string }),
    ...(v.recoveryKind === undefined ? {} : { recoveryKind: choice(v.recoveryKind, ['consultation', 'verification', 'delegation'] as const) }),
    ...(v.work === undefined ? {} : { work: (() => { const work = inspectionRecord(v.work); return { request: parseWorkRequest(work.request), draft: work.draft === null ? null : parseWorkDraft(work.draft) }; })() }),
    error: nullableText(v.error), goal: v.goal === null ? null : parseTaskGoal(v.goal),
    evidence: inspectionList(v.evidence, parseTaskEvidence, 64),
    messages: inspectionList(v.messages, raw => {
      const m = inspectionRecord(raw);
      if (m.closureReason !== undefined && (m.kind !== 'question_closed' || m.closureReason !== 'expired')) throw new TypeError('Invalid question closure reason.');
      return { id: inspectionText(m.id, 200), kind: choice(m.kind, ['question', 'question_closed', 'reply', 'verification_request', 'verification_result', ...WORK_KINDS]),
        ...(m.expiresAt === undefined ? {} : { expiresAt: parseQuestionDeadline(m.expiresAt) }),
        ...(m.closureReason === 'expired' ? { closureReason: 'expired' as const } : {}),
        from: inspectionText(m.from, 200), to: inspectionText(m.to, 200), fromName: inspectionText(m.fromName, 200), toName: inspectionText(m.toName, 200),
        questionId: inspectionText(m.questionId, 200), text: inspectionText(m.text, collaborationTextLimit(m.kind)),
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
