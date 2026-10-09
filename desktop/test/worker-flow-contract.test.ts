import { expect, test } from 'bun:test';
import { parseTaskGoal, parseTaskVerificationRequest } from '../shared/agent-task-inspection.ts';

test('paused Cheshi goals cross the inspection boundary with their decision intact', () => {
  const decision = { action: 'pause' as const, reason: 'User requested pause', progress: 'Saved changes', nextAction: 'Wait for user', criteria: [] };
  const goal = { phase: 'paused', turns: 2, verificationRequired: true, criteria: [], decisions: [decision], pending: null };
  expect(parseTaskGoal(goal)).toEqual(goal);
});

test('source review inspection retains deletion and digest without exposing source bytes', () => {
  const request = { goal: 'Verify removal', criteria: ['Removed'], artifacts: [{ path: 'old.ts', sha256: null }],
    source: { hash: 'a'.repeat(64), files: [{ path: 'old.ts', content: null, sha256: null }] } };
  const detail = parseTaskVerificationRequest(request);
  expect(detail).toEqual({ goal: request.goal, criteria: request.criteria, artifacts: request.artifacts, sourceHash: request.source.hash });
  expect(parseTaskVerificationRequest(detail)).toEqual(detail);
  expect(() => parseTaskVerificationRequest({ ...request, source: { hash: 'invalid' } })).toThrow();
  expect(() => parseTaskVerificationRequest({ ...request, source: {} })).toThrow();
  expect(() => parseTaskVerificationRequest({ ...request, source: undefined })).toThrow();
  expect(() => parseTaskVerificationRequest({ ...request, candidate: { id: 'b'.repeat(64), hash: 'c'.repeat(64) } })).toThrow();
});
