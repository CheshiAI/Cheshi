import { AgentMailbox, type Binding, type Peer } from './mailbox.mts';
import { workerOperations } from '../agent-management/operations.mts';

export interface CollaborationConnection { endpoint: string; token: string }
interface Options {
  filename: string;
  peer(binding: Binding): Peer | null;
  connect(binding: Binding): Promise<CollaborationConnection | null>;
  exchange?: typeof exchangeWorker;
}
export async function exchangeWorker(connection: CollaborationConnection, body: unknown): Promise<unknown> {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Collaboration requires a published loopback worker endpoint.');
  }
  const response = await fetch(new URL('/collaboration/exchange', url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Worker collaboration is unavailable. Start the agent to update its worker.'); }
  if (!response.body) throw new Error('Empty collaboration response.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error('Collaboration response is too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); }
}
export function createAgentOrchestration(options: Options) {
  let journal: AgentMailbox | null = null;
  const mailbox = () => journal ??= new AgentMailbox(options.filename);
  let journalError: string | null = null;
  const errors = new Map<string, string>();
  let flight: Promise<void> | null = null, timer: ReturnType<typeof setInterval> | null = null;
  async function dispatch(): Promise<void> {
    const bindings = mailbox().bindings();
    for (const binding of bindings) {
      try {
        if (!options.peer(binding)) continue;
        await workerOperations.run(async () => {
          const connection = await options.connect(binding);
          if (!connection) return;
          const peers = bindings.filter(b => b.scope === binding.scope).flatMap(b => {
            const peer = options.peer(b); return peer ? [peer] : [];
          });
          const request = mailbox().request(binding, peers);
          const response = await (options.exchange ?? exchangeWorker)(connection, request);
          if (!options.peer(binding)) throw new Error('Agent assignment changed during collaboration.');
          mailbox().accept(binding, response, peers.filter(p => bindings.some(b => b.agentId === p.id && b.scope === binding.scope && options.peer(b))), request.messages.map(m => m.id));
          errors.delete(binding.id);
        });
      } catch (error) { errors.set(binding.id, error instanceof Error ? error.message : 'Collaboration failed.'); }
    }
  }
  const tick = (): Promise<void> => {
    flight ??= dispatch().then(() => { journalError = null; }, error => {
      journalError = error instanceof Error ? error.message : 'Could not read collaboration journal.';
    }).finally(() => { flight = null; });
    return flight;
  };
  return {
    register: (binding: Binding) => mailbox().register(binding),
    error: (id: string) => journalError ?? errors.get(id) ?? null,
    tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, 2000); timer.unref(); void tick(); } },
    async dispose() { if (timer) clearInterval(timer); timer = null; await flight; },
  };
}
