// Docker transport fixture. No provider credentials, paid model requests or shell tools.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const historyPath = '/agent/flash-fixture.json';
let index = 0, output = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '', complete = Boolean(output);
const queries = ['Flash 변경 이유', 'flash 변경 이유', '플래시 변경 이유'];
const call = (tool: string, args: unknown) => send({ id: 'query', method: 'item/tool/call', params: { threadId: 'current', turnId: 'current-turn', callId: `query-${index}`, tool, arguments: args } });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params ?? {};
  if (['initialize', 'thread/inject_items', 'thread/unsubscribe'].includes(message.method)) send({ id: message.id, result: {} });
  if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' } } });
  if (message.method === 'thread/start') {
    if (!p.dynamicTools.some((t: { name: string }) => t.name === 'memory_search') || p.config['features.shell_tool'] !== false) throw new Error('Expected read-only Flash tools.');
    send({ id: message.id, result: { thread: { id: 'current' } } });
  }
  if (message.method === 'thread/read') send({ id: message.id, result: { thread: { id: p.threadId, turns: p.threadId === 'prior' ? [
    { id: 'prior-turn', status: 'completed', items: [{ id: 'prior-message', type: 'agentMessage', text: 'Flash 변경 이유: Docker 대화 원문을 유지하기 위해서입니다.' }] },
  ] : [{ id: 'current-turn', status: complete ? 'completed' : 'inProgress', items: complete ? [{ id: 'answer', type: 'agentMessage', text: output }] : [] }] } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'current-turn' } } });
    call('memory_search', { query: queries[index], limit: 10 });
  }
  if (message.id === 'query') {
    if (message.result?.success !== true) throw new Error('Flash call failed.');
    const result = JSON.parse(message.result.contentItems[0].text);
    if (result.isError || result.partial) throw new Error('Both Flash scopes must be available.');
    output += JSON.stringify(result) + '\n';
    if (index < queries.length) {
      const origins = new Set(result.matches.map((m: { origin: string }) => m.origin));
      if (!origins.has('docker') || !origins.has('local')) throw new Error('Missing Flash scope.');
      index++;
      if (index < queries.length) call('memory_search', { query: queries[index], limit: 10 });
      else call('memory_read', { question: '변경 이유가 뭐였지?', turns: result.matches.map((m: { session_id: string; turn_id: string }) => ({ session_id: m.session_id, turn_id: m.turn_id })) });
    } else {
      complete = true; writeFileSync(historyPath, output, { mode: 0o600 });
      send({ method: 'turn/completed', params: { threadId: 'current', turn: { id: 'current-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: output }], error: null } } });
    }
  }
});
