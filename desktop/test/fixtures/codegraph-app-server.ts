// Protocol fixture only: no provider login, model requests, filesystem edits or shell commands.
import { createInterface } from 'node:readline';
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), p = m.params ?? {};
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'chatgpt' } } });
  if (m.method === 'thread/start') {
    if (!p.dynamicTools.some((t: { name: string }) => t.name === 'codegraph_explore') || p.config['features.shell_tool'] !== false) throw new Error('Expected read-only CodeGraph tools.');
    send({ id: m.id, result: { thread: { id: 'thread' } } });
  }
  if (m.method === 'thread/inject_items') send({ id: m.id, result: {} });
  if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn' } } });
    send({ id: 'query', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'query', tool: 'codegraph_explore', arguments: { query: 'find fixture function', maxFiles: 30 } } });
  }
  if (m.id === 'query') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed',
    items: [{ id: 'answer', type: 'agentMessage', text: JSON.stringify(m.result) }], error: null } } });
});
