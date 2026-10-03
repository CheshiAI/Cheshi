import { expect, test } from 'bun:test';
import { GoalObservations, parseProgress, parseUsage, type GoalProgress } from './goal-progress.ts';
import { finishGoal, newGoal, parseGoal } from './decision.ts';

test('repeated observations and alternating results do not reset the persisted streak', () => {
  let state: GoalProgress | undefined;
  for (let i = 0; i < 5; i++) {
    const observed = new GoalObservations();
    observed.add({ result: i % 2, id: `delivery-${i}`, metrics: { totalMs: i } });
    state = parseProgress(JSON.parse(JSON.stringify(observed.finish(state))));
  }
  expect(state?.unchanged).toBe(3);
  expect(state?.observations).toHaveLength(2);
  const changed = new GoalObservations(); changed.add({ result: 3 });
  expect(changed.finish(state).unchanged).toBe(0);
});

test('unfinished commands and model claims cannot masquerade as observed progress', () => {
  const observed = new GoalObservations();
  observed.item('item/completed', { type: 'agentMessage', text: 'Everything improved.' });
  observed.item('item/completed', { type: 'commandExecution', status: 'inProgress', exitCode: null, command: 'test', aggregatedOutput: 'failure' });
  observed.item('item/completed', { type: 'mcpToolCall', status: 'completed', result: { isError: true, content: 'failure' } });
  expect(observed.finish(undefined)).toEqual({ unchanged: 1, observations: [] });
});

test('new file and tool results keep work moving without treating a changed claim as completion', () => {
  const observed = new GoalObservations();
  observed.item('item/completed', { type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts', diff: '+ fixed' }] });
  observed.item('item/completed', { type: 'mcpToolCall', status: 'completed', server: 'codegraph', tool: 'search', result: { content: 'new source' } });
  const state = observed.finish({ unchanged: 2, observations: [] });
  expect(state).toMatchObject({ unchanged: 0 });
  const goal = parseGoal({ ...newGoal(), turns: 1002, progressCheck: state, pending: {
    action: 'continue', progress: 'Implemented one part', reason: 'More work remains', nextAction: 'Test it',
    criteria: [{ criterion: 'Feature works', met: false, evidence: '' }],
  } });
  expect(finishGoal(goal, false)).toMatchObject({ status: 'waiting', goal: { phase: 'ready', turns: 1002 } });
  expect(() => finishGoal({ ...goal, pending: { ...goal.pending!, action: 'complete' } }, false)).toThrow('every criterion');
});

test('waiting does not advance a goal or spend turns until another event arrives', () => {
  const goal = { ...newGoal(), turns: 20, pending: { action: 'wait' as const, progress: 'Awaiting review', reason: 'Need peer evidence', nextAction: '',
    criteria: [{ criterion: 'Reviewed', met: false, evidence: '' }] } };
  expect(finishGoal(goal, true)).toMatchObject({ status: 'waiting', goal: { phase: 'waiting', turns: 20 } });
});

test('malformed persisted usage or progress is rejected', () => {
  expect(() => parseProgress({ unchanged: -1, observations: [] })).toThrow();
  expect(() => parseProgress({ unchanged: 0, observations: ['not-a-hash'] })).toThrow();
  expect(() => parseUsage({ reportedThroughTurn: true, inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toThrow();
});


test('a new command diagnostic is information but repeating the same failure is not progress', () => {
  let state: GoalProgress | undefined;
  for (let i = 0; i < 4; i++) {
    const observed = new GoalObservations();
    observed.item('item/completed', { id: String(i), type: 'commandExecution', status: 'completed', command: 'test', exitCode: 1, aggregatedOutput: 'Missing import' });
    state = observed.finish(state);
  }
  expect(state?.unchanged).toBe(3);
  const diagnostic = new GoalObservations();
  diagnostic.item('item/completed', { type: 'commandExecution', status: 'completed', command: 'test', exitCode: 1, aggregatedOutput: 'Wrong result after import fixed' });
  expect(diagnostic.finish(state).unchanged).toBe(0);
});

test('recall snapshot ids and telemetry cannot disguise rereading the same source', () => {
  let state: GoalProgress | undefined;
  for (let i = 0; i < 4; i++) {
    const observed = new GoalObservations();
    observed.history({ snapshot: String(i), metrics: { totalMs: i }, originals: [{ itemId: String(i), text: 'Use email login' }] });
    state = observed.finish(state);
  }
  expect(state?.unchanged).toBe(3);
  const empty = new GoalObservations(); empty.history({ snapshot: 'new', originals: [], matches: [] });
  expect(empty.finish(undefined).observations).toEqual([]);
});
