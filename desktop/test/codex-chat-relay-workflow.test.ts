import { describe, expect, test } from 'bun:test';
import { runChatRelayWorkflow, type ChatRelayWorkflowTurn } from '../lib/codex-chat-relay-workflow.mts';
import { chatRelayRequest, formatChatRelayConsensusReply } from '../shared/chat-relay.ts';
import type { ChatRelayState } from '../shared/chat-relay.ts';
import { expectFailure } from './codex-chat-test-helpers.ts';

function reply(version: number, decision: 'agree' | 'revise' | 'disagree', proposal: string | null = null, issues: string[] = []) {
  return formatChatRelayConsensusReply({ kind: 'cheshi-relay-consensus', version, decision, proposal, issues, summary: `Decision: ${decision}` });
}

async function workflow(outputs: string[], options: { mode?: 'review' | 'debate' | 'consensus'; maxRounds?: number; abortAfter?: number } = {}) {
  const request = chatRelayRequest({ sourceContextId: 'a', sourceThreadId: 'thread-a', targetContextId: 'b', targetThreadId: 'thread-b', objective: 'Choose a plan.', mode: options.mode ?? 'consensus', maxRounds: options.maxRounds ?? 2 });
  const turns: ChatRelayWorkflowTurn[] = [];
  const state: Partial<ChatRelayState> = {};
  const abort = new AbortController();
  const result = await runChatRelayWorkflow(request, {
    signal: abort.signal,
    update(progress) { Object.assign(state, progress); },
    async turn(turn) {
      turns.push(turn);
      if (turns.length === options.abortAfter) abort.abort(new Error('Test stopped'));
      const output = outputs[turns.length - 1];
      if (output === undefined) throw new Error('Unexpected extra turn');
      return output;
    },
  });
  return { result, state, turns };
}

describe('relay workflow modes', () => {
  test('retains the three review steps', async () => {
    const run = await workflow(['proposal', 'review', 'revision'], { mode: 'review' });
    expect(run.turns.map(({ speaker, provenance }) => [speaker, provenance.role])).toEqual([
      ['A', 'proposal'], ['B', 'review'], ['A', 'revision'],
    ]);
    expect(run.result).toMatchObject({ outcome: 'reviewed', summary: 'revision' });
  });

  test('sends the complete ordered debate to separate moderator C without claiming agreement', async () => {
    const run = await workflow(['A1', 'B1', 'A2', 'B2', 'C synthesis'], { mode: 'debate' });
    expect(run.turns.map(({ speaker, provenance }) => [speaker, provenance.round, provenance.step])).toEqual([
      ['A', 1, 1], ['B', 1, 2], ['A', 2, 3], ['B', 2, 4], ['C', 2, 5],
    ]);
    expect(run.turns[3]?.body).toContain('State your final position');
    expect(run.turns[2]?.provenance).toMatchObject({ sourceThreadId: 'thread-b', displayText: 'B1' });
    const transcript = ['### Round 1 · A · thread-a\n\nA1', '### Round 1 · B · thread-b\n\nB1',
      '### Round 2 · A · thread-a\n\nA2', '### Round 2 · B · thread-b\n\nB2'].join('\n\n');
    expect(run.turns[4]?.provenance).toMatchObject({ role: 'synthesis', sourceThreadIds: ['thread-a', 'thread-b'], displayText: transcript });
    expect(run.turns[4]?.body).toContain(`<quoted_conversation_output>\n${transcript}\n</quoted_conversation_output>`);
    expect(run.result).toMatchObject({ outcome: 'debated', summary: 'C synthesis' });
  });

  test('cancels the moderator response without completing the result', async () => {
    await expectFailure(() => workflow(['A1', 'B1', 'C synthesis'], { mode: 'debate', maxRounds: 1, abortAfter: 3 }), 'Test stopped');
  });

  test('does not call C when B’s final turn is stopped', async () => {
    await expectFailure(() => workflow(['A1', 'B1'], { mode: 'debate', maxRounds: 1, abortAfter: 2 }), 'Test stopped');
  });

  test('retains all ten participant outputs at the maximum round limit', async () => {
    const outputs = Array.from({ length: 10 }, (_, index) => `Argument-${index + 1}`);
    const run = await workflow([...outputs, 'C result'], { mode: 'debate', maxRounds: 5 });
    expect(run.turns).toHaveLength(11);
    for (const output of outputs) expect(run.turns[10]?.provenance.displayText).toContain(output);
    expect(run.turns[10]?.speaker).toBe('C');
    expect(run.result.summary).toBe('C result');
  });

  test('requires B and then A to agree to the exact same proposal version', async () => {
    const run = await workflow([reply(1, 'agree', 'Plan one'), reply(1, 'agree'), reply(1, 'agree')]);
    expect(run.turns.map(({ speaker, provenance }) => [speaker, provenance.role])).toEqual([
      ['A', 'proposal'], ['B', 'review'], ['A', 'confirmation'],
    ]);
    expect(run.state).toMatchObject({ proposalVersion: 1, proposal: 'Plan one', issues: [] });
    expect(run.result.outcome).toBe('agreed');
    expect(run.turns[2]?.body).toContain('<quoted_proposal>\nPlan one\n</quoted_proposal>');
  });

  test('starts a new version after requested changes without confirming a rejected proposal', async () => {
    const run = await workflow([
      reply(1, 'agree', 'Plan one'), reply(1, 'revise', null, ['Missing recovery']),
      reply(2, 'agree', 'Plan two'), reply(2, 'agree'), reply(2, 'agree'),
    ]);
    expect(run.turns.map(({ provenance }) => provenance.role)).toEqual(['proposal', 'review', 'proposal', 'review', 'confirmation']);
    expect(run.turns[2]?.provenance.displayText).toContain('Missing recovery');
    expect(run.state.proposalVersion).toBe(2);
    expect(run.result.outcome).toBe('agreed');
  });

  test('keeps dissent and stops at the round limit', async () => {
    const run = await workflow([reply(1, 'agree', 'Plan'), reply(1, 'disagree', null, ['Too costly'])], { maxRounds: 1 });
    expect(run.result.outcome).toBe('limit');
    expect(run.state.issues).toEqual(['Too costly']);
    expect(run.turns).toHaveLength(2);
  });

  test('an agree decision with open issues cannot establish agreement', async () => {
    const run = await workflow([reply(1, 'agree', 'Plan'), reply(1, 'agree', null, ['Unresolved risk'])], { maxRounds: 1 });
    expect(run.result.outcome).toBe('limit');
    expect(run.state.issues).toEqual(['Unresolved risk']);
    expect(run.turns).toHaveLength(2);
  });

  test('does not claim agreement when A declines final confirmation', async () => {
    const run = await workflow([
      reply(1, 'agree', 'Plan'), reply(1, 'agree'), reply(1, 'revise', null, ['Capacity risk']),
      reply(2, 'agree', 'Revised plan'), reply(2, 'agree'), reply(2, 'agree'),
    ]);
    expect(run.result.outcome).toBe('agreed');
    expect(run.turns[3]?.provenance).toMatchObject({ sourceThreadId: 'thread-a', round: 2 });
    expect(run.turns[3]?.provenance.displayText).toContain('Capacity risk');
  });

  test('rejects malformed, wrong-version, empty-proposal, and rewritten-vote responses', async () => {
    await expectFailure(() => workflow(['I agree']), 'The consensus response did not contain a valid structured decision.');
    await expectFailure(() => workflow([reply(2, 'agree', 'Plan')]), 'The consensus response refers to a different proposal version.');
    await expectFailure(() => workflow([reply(1, 'agree')]), 'The consensus proposal is empty.');
    await expectFailure(() => workflow([reply(1, 'agree', 'Plan'), reply(2, 'agree')]), 'The consensus response refers to a different proposal version.');
    await expectFailure(() => workflow([reply(1, 'agree', 'Plan'), reply(1, 'agree', 'Changed plan')]), 'A consensus vote cannot change the proposal being reviewed.');
    await expectFailure(() => workflow([reply(1, 'agree', 'Plan'), reply(1, 'agree'), reply(2, 'agree')]), 'The consensus response refers to a different proposal version.');
  });

  test('preserves the last validated proposal when a later proposal fails or is stopped', async () => {
    for (const stop of [false, true]) {
      const state: Partial<ChatRelayState> = {};
      const abort = new AbortController();
      let turn = 0;
      const request = chatRelayRequest({ sourceContextId: 'a', sourceThreadId: 'thread-a',
        targetContextId: 'b', targetThreadId: 'thread-b', objective: 'Choose a plan.', mode: 'consensus', maxRounds: 2 });
      await expectFailure(() => runChatRelayWorkflow(request, {
        signal: abort.signal,
        update(progress) { Object.assign(state, progress); },
        async turn() {
          turn += 1;
          if (turn === 1) return reply(1, 'agree', 'Last validated plan');
          if (turn === 2) return reply(1, 'revise', null, ['Recovery missing']);
          if (stop) {
            abort.abort(new Error('Proposal interrupted'));
            return reply(2, 'agree', 'Unvalidated replacement');
          }
          throw new Error('Proposal interrupted');
        },
      }), 'Proposal interrupted');
      expect(state).toMatchObject({ round: 2, proposalVersion: 1, proposal: 'Last validated plan', issues: ['Recovery missing'] });
    }
  });

  test('does not advance when cancellation arrives after a completed response', async () => {
    await expectFailure(() => workflow(['A1'], { mode: 'debate', abortAfter: 1 }), 'Test stopped');
  });
});
