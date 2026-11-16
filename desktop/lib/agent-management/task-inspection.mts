import { collaborationTextLimit, WORK_MESSAGE_LIMIT, parseWorkRequest, parseWorkDraft } from '../../shared/agent-work.ts';
import { parseAgentTasks, type AgentTask } from '../../shared/agent-management.ts';
import { parseQuestionDeadline } from '../../shared/agent-question.ts';
import { inspectionRecord, inspectionText, inspectionList, parseTaskInspection, parseTaskGoal, parseTaskEvidence,
  parseTaskVerification, parseTaskVerificationRequest, type TaskMessage, type TaskInspection } from '../../shared/agent-task-inspection.ts';

/** Project only the selected task's records, never the raw worker snapshot or credentials. */
export function inspectAgentTasks(value: unknown, owner?: { id: string; name: string }): AgentTask[] {
  const state = inspectionRecord(value), raw = inspectionList(state.tasks, inspectionRecord, 10_000);
  const tasks = parseAgentTasks(raw).slice(-100).reverse();
  return tasks.map(task => {
    const original = raw.find(item => item.id === task.id)!;
    try {
      const c = state.collaboration === undefined ? null : inspectionRecord(state.collaboration);
      const names = new Map(c ? inspectionList(c.peers, item => {
        const peer = inspectionRecord(item);
        return [inspectionText(peer.id, 200), inspectionText(peer.name, 200)] as const;
      }, 10_000) : []);
      if (owner) names.set(owner.id, owner.name);
      const consumed = c ? inspectionList(c.consumed, id => inspectionText(id, 200), 10_000) : [];
      const acknowledged = c ? inspectionList(c.acknowledged, id => inspectionText(id, 200), 10_000) : [];
      const messages: TaskMessage[] = [];
      const deadlines = c?.questionDeadlines === undefined ? {} : inspectionRecord(c.questionDeadlines);
      for (const direction of ['outgoing', 'incoming'] as const) {
        const entries = c ? inspectionList(c[direction], inspectionRecord, 10_000) : [];
        for (const m of entries) {
          const requestId = original.consultation ?? original.verification ?? original.delegation;
          if (requestId ? m.questionId !== requestId : m.taskId !== task.id) continue;
          const id = inspectionText(m.id, 200), from = inspectionText(m.from, 200), to = inspectionText(m.to, 200);
          const text = inspectionText(m.text, collaborationTextLimit(m.kind));
          messages.push({ id, kind: m.kind as TaskMessage['kind'], from, to, fromName: names.get(from) ?? from, toName: names.get(to) ?? to,
            ...(direction === 'outgoing' && m.kind === 'question' ? { expiresAt: parseQuestionDeadline(deadlines[id] ?? null) } : {}),
            ...(m.closureReason === undefined ? {} : { closureReason: m.closureReason as TaskMessage['closureReason'] }),
            questionId: inspectionText(m.questionId, 200), text,
            delivery: direction === 'outgoing' ? acknowledged.includes(id) ? 'delivered' : 'queued' : consumed.includes(id) ? 'processed' : 'received',
            request: m.kind === 'verification_request' ? parseTaskVerificationRequest(JSON.parse(text)) : null,
            verification: m.kind === 'verification_result' ? parseTaskVerification(JSON.parse(text)) : null });
        }
      }
      const workRequest = typeof original.delegation === 'string' && c ? inspectionList(c.incoming, inspectionRecord, 10_000).find(m => m.id === original.delegation && m.kind === 'work_request') : null;
      const detail = parseTaskInspection({
        ...(original.permissionRequest === undefined ? {} : { permissionRequest: original.permissionRequest }),
        ...(original.activity === undefined ? {} : { activity: original.activity, activityTruncated: original.activityTruncated === true }),
        ...(original.dialogue === undefined ? {} : { dialogue: original.dialogue }),
        ...(original.integration === undefined ? {} : { integration: original.integration }),
        ...(workRequest ? { work: { request: parseWorkRequest(JSON.parse(inspectionText(workRequest.text, WORK_MESSAGE_LIMIT))), draft: original.workDraft === undefined ? null : parseWorkDraft(original.workDraft) } } : {}), finishedAt: original.finishedAt, threadId: original.threadId, conversation: original.conversation,
        ...(task.status === 'unknown' && original.goal === undefined && original.roomId !== undefined
          && ((typeof original.consultation === 'string' && original.consultation && original.verification === undefined)
            || (typeof original.verification === 'string' && original.verification && original.consultation === undefined) || (typeof original.delegation === 'string' && original.delegation && original.consultation === undefined && original.verification === undefined))
          ? { recoveryRoomId: original.roomId, recoveryKind: original.delegation ? 'delegation' : original.verification ? 'verification' : 'consultation' } : {}),
        goal: original.goal === undefined ? null : parseTaskGoal(original.goal), messages,
        evidence: original.verificationEvidence === undefined ? [] : inspectionList(original.verificationEvidence, parseTaskEvidence, 64), error: null });
      return { ...task, inspection: detail };
    } catch {
      const inspection: TaskInspection = { finishedAt: null, threadId: null, conversation: null, goal: null, messages: [], evidence: [],
        error: 'Some task detail records are invalid or exceed the inspection limit. The saved request and output remain available.' };
      return { ...task, inspection };
    }
  });
}
