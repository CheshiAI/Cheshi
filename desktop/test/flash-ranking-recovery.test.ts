import { expect, test } from 'bun:test';
import { FlashError } from '../lib/flash/client.mts';
import { interleaveCandidates, rankWithRecovery } from '../lib/flash/ranking-recovery.mts';
import { verifiedSummarizer, type SummaryInput } from '../lib/flash/summary.mts';
import { ProviderRequestError, retryInference } from '../../experiments/codex-specialists/src/provider-recovery.ts';
import { flashRelayFailure } from '../lib/agent-orchestration/flash-relay.mts';

async function failure(operation: () => Promise<unknown>) {
  try { await operation(); } catch (error) { return error; }
  throw new Error('Expected rejection');
}
test('fallback retains both scopes and original objects, exposing degradation without provider text', async () => {
  const own = [{ source_id: 'd1' }, { source_id: 'd2' }], local = [{ source_id: 'l1' }];
  const candidates = interleaveCandidates([own, local]);
  const result = await rankWithRecovery('query', candidates, new AbortController().signal, async () => {
    throw new FlashError('model_unavailable', 'PRIVATE PROVIDER INPUT');
  });
  expect(result.matches).toEqual([own[0]!, local[0]!, own[1]!]); expect(result.matches[0]).toBe(own[0]);
  expect(result).toMatchObject({ ranking: 'local_fallback', degraded: true, ranking_error: 'model_unavailable' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
test('stale originals, cancellation and unexpected failures never become fallback success', async () => {
  for (const error of [new FlashError('stale_source', 'changed'), new Error('unexpected')]) {
    expect(await failure(() => rankWithRecovery('q', [], new AbortController().signal, async () => { throw error; }))).toBe(error);
  }
  const controller = new AbortController();
  await failure(() => rankWithRecovery('q', [], controller.signal, async () => { controller.abort(); throw new FlashError('model_unavailable', 'busy'); }));
  expect(controller.signal.aborted).toBe(true);
});
test('retrying semantic review does not regenerate the successful draft', async () => {
  const input: SummaryInput = { question: 'why', turns: [{ session_id: 's', turn_id: 't', messages: [
    { session_id: 's', turn_id: 't', source_id: 'source', message_id: 'm', kind: 'assistant', entry: 0, text: 'Only a proposal.' },
  ] }] };
  let drafts = 0, audits = 0;
  const summarize = verifiedSummarizer((_instructions, payload, _schema, signal) => retryInference(async () => {
    if ('draft' in (payload as Record<string, unknown>)) { if (++audits === 1) throw new ProviderRequestError({ code: 'server_overloaded' }); }
    else drafts++;
    return { summary: 'Only a proposal.', insufficient_evidence: false, evidence: ['p0'] };
  }, signal, async () => {}));
  expect(await summarize(input, new AbortController().signal)).toMatchObject({ summary: 'Only a proposal.' });
  expect(drafts).toBe(1); expect(audits).toBe(2);
});

test('quota failures keep their safe category and are not advertised as retryable', () => {
  const result = flashRelayFailure(new FlashError('model_unavailable', 'PRIVATE', { code: 'insufficient_quota', retryable: false }), new AbortController().signal);
  expect(result).toMatchObject({ provider_failure: { code: 'insufficient_quota', retryable: false }, retryable: false });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
