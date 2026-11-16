import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { inspectAgentTasks } from '../lib/agent-management/task-inspection.mts';
import { parseAgentTasks } from '../shared/agent-management.ts';
import { parseTaskGoal, parseTaskEvidence } from '../shared/agent-task-inspection.ts';
import config from '../../forge.config.mts';
import { WORK_MESSAGE_LIMIT } from '../shared/agent-work.ts';

const task = { id: 'goal', prompt: 'Build login', status: 'waiting', createdAt: '2026-10-03', output: 'Progress', error: null,
  threadId: 'thread', finishedAt: null };
const goal = { phase: 'waiting', turns: 1, criteria: [{ criterion: 'Login works', met: false, evidence: '' }], decisions: [], pending: null, verificationRequired: true };
const message = { id: 'question', kind: 'question', taskId: 'goal', questionId: 'question', from: 'developer', to: 'planner', text: 'Which login method?' };
test('generated collaboration prompts survive host and preload projection without widening user inputs', () => {
  for (const length of [20_182, WORK_MESSAGE_LIMIT, WORK_MESSAGE_LIMIT + 1024]) {
    const prompt = 'x'.repeat(length);
    expect(parseAgentTasks(inspectAgentTasks({ tasks: [{ ...task, prompt }] }))[0]?.prompt).toBe(prompt);
  }
  expect(() => parseAgentTasks([{ ...task, prompt: 'x'.repeat(WORK_MESSAGE_LIMIT + 1025) }])).toThrow('Invalid agent text');
  expect(() => parseAgentTasks([{ ...task, roomId: 'room', inputs: [{ id: 'input', prompt: 'x'.repeat(20_001) }] }])).toThrow('Invalid agent text');
});
function snapshot() {
  return { tasks: [{ ...task, goal }], collaboration: {
    peers: [{ id: 'planner', name: 'Planning', role: 'planning' }], outgoing: [message],
    incoming: [{ ...message, id: 'answer', kind: 'reply', from: 'planner', to: 'developer', text: 'Email login' }],
    consumed: [] as string[], acknowledged: ['question'],
  } };
}
test('ordinary task usage crosses host and preload boundaries without a goal', () => {
  const usage = { turns: [{ threadId: 'thread', turnId: 'turn', modelCalls: 2,
    tokens: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 5, totalTokens: 205 }, threadTotals: null }] };
  const result = parseAgentTasks(inspectAgentTasks({ tasks: [{ ...task, usage }] }))[0]!;
  expect(result.usage).toEqual(usage);
  expect(result.inspection?.goal).toBeNull();
  expect(parseAgentTasks([task])[0]?.usage).toBeUndefined();
});
test('activity projection carries goal and only this task messages through the preload contract', () => {
  const input = snapshot();
  input.collaboration.outgoing.push({ ...message, id: 'unrelated', taskId: 'different', text: 'PRIVATE_OTHER_TASK' });
  const tasks = parseAgentTasks(inspectAgentTasks(input, { id: 'developer', name: 'Development' }));
  const detail = tasks[0]!.inspection!;
  expect(detail.goal?.verificationRequired).toBe(true);
  expect(detail.messages).toHaveLength(2);
  expect(detail.messages[0]?.fromName).toBe('Development');
  expect(detail.messages[0]?.toName).toBe('Planning');
  expect(detail.messages[0]?.delivery).toBe('delivered');
  expect(detail.messages[1]?.delivery).toBe('received');
  expect(JSON.stringify(tasks)).not.toContain('PRIVATE_OTHER_TASK');
  input.collaboration.consumed = ['answer'];
  expect(inspectAgentTasks(input)[0]?.inspection?.messages[1]?.delivery).toBe('processed');
});
test('consultation and verifier tasks connect by request identity rather than another agent task id', () => {
  const input = snapshot();
  const tasks = inspectAgentTasks({ ...input, tasks: [{ ...task, id: 'consult-task', consultation: 'question' }] });
  expect(tasks[0]?.inspection?.messages).toHaveLength(2);
  expect(tasks[0]?.inspection?.messages[1]?.text).toBe('Email login');
});
test('malformed detail leaves base task output available and booleans are literal', () => {
  expect(() => parseTaskGoal({ ...goal, verificationRequired: 'true' })).toThrow();
  expect(() => parseTaskGoal({ ...goal, criteria: [{ criterion: 'x', met: 'false', evidence: '' }] })).toThrow();
  const result = inspectAgentTasks({ tasks: [{ ...task, goal: { ...goal, turns: -1 } }] })[0]!;
  expect(result.output).toBe('Progress');
  expect(result.inspection?.error).toContain('invalid');
  expect(parseTaskEvidence({ id: 'receipt', kind: 'command', detail: 'bun test', output: '', exitCode: 0, successful: false }).successful).toBe(false);
  const legacy = inspectAgentTasks({ tasks: [task] })[0]!;
  expect(legacy.inspection?.goal).toBeNull(); expect(legacy.inspection).not.toHaveProperty('recall');
});
test('independent verdicts and observed evidence survive projection separately from self report', () => {
  const input = snapshot();
  const result = { verdicts: [{ criterion: 'Login works', verdict: 'fail', reason: 'Wrong status', evidenceIds: ['check'] }],
    evidence: [{ id: 'check', kind: 'command', detail: 'bun test', output: 'expected 401', exitCode: 1, successful: false }] };
  input.collaboration.incoming.push({ ...message, id: 'verification', kind: 'verification_result', from: 'verifier', text: JSON.stringify(result) });
  const inspection = parseAgentTasks(inspectAgentTasks(input))[0]!.inspection!;
  expect(inspection.messages.at(-1)?.verification?.verdicts[0]?.verdict).toBe('fail');
  expect(inspection.messages.at(-1)?.verification?.evidence[0]?.exitCode).toBe(1);
  expect(inspection.goal?.criteria[0]?.met).toBe(false);
});
test('inspection modules and their transitive contracts are packaged and load with native Node', async () => {
  const ignore = (await config()).packagerConfig?.ignore;
  if (typeof ignore !== 'function') throw new Error('Missing package filter');
  for (const path of ['experiments/codex-specialists/src/usage-contract.ts', 'experiments/codex-specialists/src/activity-contract.ts', 'desktop/lib/agent-chats/records.mts', 'desktop/shared/agent-activity.ts', 'desktop/shared/agent-question.ts', 'desktop/shared/agent-task-inspection.ts', 'desktop/lib/agent-management/task-inspection.mts']) expect(ignore(`/${path}`)).toBe(false);
  execFileSync('node', ['--input-type=module', '-e', "await import('./desktop/lib/agent-management/service.mts')"], { stdio: 'pipe' });
});

test('inspection projects owner deadlines and explicit expiry reason and rejects malformed persisted dates', () => {
  const base = snapshot(), expiresAt = '2099-01-01T00:00:00.000Z';
  const input = { ...base, collaboration: { ...base.collaboration, questionDeadlines: { question: expiresAt },
    outgoing: [message, { ...message, id: 'expired', kind: 'question_closed', closureReason: 'expired', text: 'Question expired.' }] } };
  const detail = parseAgentTasks(inspectAgentTasks(input))[0]!.inspection!;
  expect(detail.messages[0]?.expiresAt).toBe(expiresAt);
  expect(detail.messages[1]?.closureReason).toBe('expired');
  input.collaboration.questionDeadlines.question = 'not a date';
  expect(inspectAgentTasks(input)[0]?.inspection?.error).toContain('invalid');
});

test('only unknown room consultations and verifications expose the scoped inspection action', () => {
  const consultation = { ...task, id: 'q_question', roomId: 'room', consultation: 'question', status: 'unknown' };
  const project = (t: unknown) => parseAgentTasks(inspectAgentTasks({ tasks: [t] }))[0]!.inspection;
  expect(project(consultation)?.recoveryRoomId).toBe('room');
  expect(project(consultation)?.recoveryKind).toBe('consultation');
  const verification = { ...consultation, consultation: undefined, verification: 'request' };
  expect(project(verification)).toMatchObject({ recoveryRoomId: 'room', recoveryKind: 'verification' });
  for (const other of [{ ...verification, status: 'interrupted' }, { ...verification, roomId: undefined }, { ...verification, goal }]) {
    expect(project(other)?.recoveryRoomId).toBeUndefined();
  }
  for (const other of [{ ...consultation, status: 'interrupted' }, { ...consultation, roomId: undefined },
    { ...consultation, consultation: undefined }, { ...consultation, verification: 'verification' }]) {
    expect(project(other)?.recoveryRoomId).toBeUndefined();
  }
  expect(() => project({ ...consultation, roomId: '../foreign' })).toThrow();
});


test('long-lived goals expose cumulative usage and unknown legacy usage without an execution cap', () => {
  const usage = { reportedThroughTurn: 1200, inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  expect(parseTaskGoal({ ...goal, turns: 1201, usage })).toMatchObject({ turns: 1201, usage });
  expect(parseTaskGoal({ ...goal, turns: 1201 }).usage).toBeUndefined();
  expect(() => parseTaskGoal({ ...goal, usage: { ...usage, totalTokens: '120' } })).toThrow('usage');
});

test('old worker recall payloads are discarded while task output remains available', () => {
  const result = inspectAgentTasks({ tasks: [task], recall: [{ taskId: task.id, activity: { sources: [{ text: 'OLD_PRIVATE_SOURCE' }] } }] });
  expect(result[0]?.output).toBe(task.output);
  expect(result[0]?.inspection).not.toHaveProperty('recall');
  expect(JSON.stringify(result)).not.toContain('OLD_PRIVATE_SOURCE');
});
