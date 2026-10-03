import { expect, test } from 'bun:test';
import { finishGoal, newGoal, parseDecision, parseGoal, validateDecision } from './decision.ts';
const decision = (action = 'complete') => parseDecision({ action, reason: 'Checked the output', progress: 'Result inspected', nextAction: '',
  criteria: [{ criterion: 'Match the requested output', met: true, evidence: 'Result matches the expected output.' }] });
test('completion cannot ignore pending peer answers or replace accepted criteria', () => {
  expect(() => validateDecision(newGoal(), decision(), true)).toThrow('unresolved');
  const goal = { ...newGoal(), criteria: [{ criterion: 'Original requirement', met: false, evidence: '' }] };
  expect(() => validateDecision(goal, decision(), false)).toThrow('original completion criteria');
  expect(() => parseDecision({ ...decision(), criteria: [{ criterion: 'A', met: 'true', evidence: 'B' }] })).toThrow('boolean');
  expect(() => validateDecision(newGoal(), { ...decision(), criteria: [{ criterion: 'A', met: false, evidence: '' }] }, false)).toThrow('every criterion');
});
test('decision and progress survive serialization without committing a pending decision', () => {
  const goal = { ...newGoal(), turns: 1, pending: decision('wait') };
  const saved = parseGoal(JSON.parse(JSON.stringify(goal)));
  expect(saved.phase).toBe('active');
  expect(finishGoal(saved, true)).toMatchObject({ status: 'waiting', goal: { phase: 'waiting', pending: null, turns: 1 } });
  expect(parseGoal({ ...goal, turns: 1001 }).turns).toBe(1001);
  expect(() => parseGoal({ ...goal, turns: -1 })).toThrow('Invalid saved goal');
});
