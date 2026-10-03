// Protocol fixture only: no provider, credentials, filesystem tools, or external requests.
import { createInterface } from 'node:readline';
type ObjectValue = Record<string, unknown>;
const send = (value: ObjectValue) => process.stdout.write(`${JSON.stringify(value)}\n`);
const profile = process.env.FIXTURE_PROFILE;
let sequence = 0;
const callbacks = new Map<string, (result: ObjectValue) => void>();
function call(tool: string, args: ObjectValue, threadId: unknown, turnId: string, done: (value: ObjectValue) => void) {
  const id = `tool-${++sequence}`;
  callbacks.set(id, done);
  send({ id, method: 'item/tool/call', params: { threadId, turnId, callId: id, namespace: null, tool, arguments: args } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line) as ObjectValue;
  const params = (m.params ?? {}) as ObjectValue;
  if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
  if (m.method === 'account/read') { send({ id: m.id, result: { account: { type: 'chatgpt' } } }); return; }
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    send({ id: m.id, result: { thread: { id: params.threadId ?? `${profile}-thread-${++sequence}` } } }); return;
  }
  if (m.method === 'thread/inject_items') { send({ id: m.id, result: {} }); return; }
  if (m.method === 'turn/start') {
    const turnId = `turn-${++sequence}`;
    send({ id: m.id, result: { turn: { id: turnId } } });
    const complete = (text: string) => send({ method: 'turn/completed', params: { threadId: params.threadId,
      turn: { id: turnId, status: 'completed', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text }], error: null } } });
    if (profile === 'planner') { complete('Require email and password.'); return; }
    const decide = (action: string, output: string) => call('record_decision', {
      action, reason: 'The protocol fixture observed this stage.', progress: output,
      nextAction: action === 'continue' ? 'Verify the received policy is reflected in the result.' : '',
      criteria: [{ criterion: 'Apply and verify the received login policy.', met: action === 'complete',
        evidence: action === 'complete' ? 'Fixture verified the policy after the continuation turn.' : '' }],
    }, params.threadId, turnId, response => complete(response.success === true ? output : `Decision failed: ${JSON.stringify(response)}`));
    if (JSON.stringify(params.input).includes('Peer replies')) { decide('continue', 'Received policy; checking the result next.'); return; }
    if (JSON.stringify(params.input).includes('Saved goal state')) { decide('complete', 'Continued login using the received policy.'); return; }
    call('ask_agent', { agentId: 'planner', requestId: 'credentials', question: 'Which credentials should login accept?' }, params.threadId, turnId, response => {
      if (response.success !== true) { complete(`Tool failed: ${JSON.stringify(response)}`); return; }
      decide('wait', 'Independent input validation completed. Waiting for the login policy.');
    });
    return;
  }
  if (typeof m.id === 'string' && callbacks.has(m.id)) {
    const done = callbacks.get(m.id)!; callbacks.delete(m.id); done(m.result as ObjectValue);
  }
});
