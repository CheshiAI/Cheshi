// Scripted protocol peer for repeatable integration tests. File edits and test execution are real;
// model judgment is a fixture. The separate opt-in native test uses the actual Codex app-server.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, VerificationRequest, VerificationResult } from '../../../experiments/codex-specialists/src/verification-contract.ts';
type Value = Record<string, unknown>;
const send = (value: Value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const callbacks = new Map<string, (result: Value) => void>();
let sequence = 0;
const criterion = 'Accept only nonempty email and password.';
async function turn(params: Value, turnId: string): Promise<void> {
  const call = async (tool: string, args: Value) => {
    const id = `call-${++sequence}`;
    const response = await new Promise<Value>(resolve => {
      callbacks.set(id, resolve);
      send({ id, method: 'item/tool/call', params: { threadId: params.threadId, turnId, callId: id, tool, arguments: args } });
    });
    const content = response.contentItems as { text: string }[];
    if (response.success !== true) throw new Error(content?.[0]?.text ?? 'Tool failed');
    return JSON.parse(content[0]!.text) as Value;
  };
  const complete = (text: string) => send({ method: 'turn/completed', params: { threadId: params.threadId,
    turn: { id: turnId, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text }], error: null } } });
  const role = process.env.FIXTURE_PROFILE;
  if (role === 'planner') { complete('Require both nonempty email and password.'); return; }
  if (role === 'reviewer') {
    const request = (await call('verification_status', {})).request as VerificationRequest;
    for (const artifact of request.artifacts) await call('verification_read', { path: artifact.path });
    const item = { id: `check-${++sequence}`, type: 'commandExecution', command: 'bun test login.test.ts', cwd: params.cwd };
    send({ method: 'item/started', params: { threadId: params.threadId, turnId, item: { ...item, status: 'inProgress' } } });
    const check = Bun.spawn([process.execPath, 'test', 'login.test.ts'], { cwd: String(params.cwd), stdout: 'pipe', stderr: 'pipe' });
    const [output, errors, exitCode] = await Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text(), check.exited]);
    send({ method: 'item/completed', params: { threadId: params.threadId, turnId, item: { ...item, status: 'completed', exitCode, aggregatedOutput: output + errors } } });
    const { evidence } = await call('verification_status', {});
    await call('submit_verification', { verdicts: [{ criterion, verdict: exitCode === 0 ? 'pass' : 'fail',
      reason: exitCode === 0 ? 'All four cases passed.' : 'Empty password was accepted; expected false.', evidenceIds: (evidence as Evidence[]).map(e => e.id) }] });
    complete(exitCode === 0 ? 'Verification passed.' : 'Fix empty-password rejection.'); return;
  }
  const status = await call('goal_status', {});
  const decide = async (action: string) => {
    await call('record_decision', { action, reason: 'Observed the current stage.', progress: `Stage ${status.turns}`,
      nextAction: '', criteria: [{ criterion, met: action === 'complete', evidence: action === 'complete' ? 'Independent file and command receipts passed.' : '' }] });
    complete(`Stage ${status.turns}: ${action}`);
  };
  if (status.turns === 1) {
    await call('ask_agent', { agentId: 'planner', requestId: 'policy', question: 'Which credentials are required?' });
    await decide('wait'); return;
  }
  const reviews = (await call('verification_status', {})).results as { result: VerificationResult }[];
  if (reviews.length && reviews.at(-1)!.result.verdicts.every((v) => v.verdict === 'pass')) {
    await decide('complete'); return;
  }
  if (reviews.length) writeFileSync(join(String(params.cwd), 'login.ts'), 'export const accepts = (email: string, password: string) => Boolean(email && password);\n');
  await call('request_verification', { agentId: 'reviewer', requestId: `round-${status.turns}`, criteria: [criterion], paths: ['login.ts', 'login.test.ts'] });
  await decide('wait');
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line) as Value, params = (m.params ?? {}) as Value;
  if (typeof m.id === 'string' && callbacks.has(m.id)) { const done = callbacks.get(m.id)!; callbacks.delete(m.id); done(m.result as Value); return; }
  if (m.method === 'initialize' || m.method === 'thread/inject_items') { send({ id: m.id, result: {} }); return; }
  if (m.method === 'account/read') { send({ id: m.id, result: { account: { type: 'chatgpt' } } }); return; }
  if (m.method === 'thread/start' || m.method === 'thread/resume') { send({ id: m.id, result: { thread: { id: params.threadId ?? `thread-${++sequence}` } } }); return; }
  if (m.method === 'turn/start') {
    const turnId = `turn-${++sequence}`; send({ id: m.id, result: { turn: { id: turnId } } });
    void turn(params, turnId).catch(error => send({ method: 'turn/completed', params: { threadId: params.threadId,
      turn: { id: turnId, status: 'failed', items: [], error: { message: String(error) } } } }));
  }
});
