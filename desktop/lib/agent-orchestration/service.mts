import { AgentMailbox, type Binding, type Peer, type Message } from './mailbox.mts';
import { AgentHistoryRelay, type AgentHistoryOptions } from './history-relay.mts';
import { workerOperations } from '../agent-management/operations.mts';

export interface CollaborationConnection { endpoint: string; token: string }
interface Options {
  filename: string;
  peer(binding: Binding): Peer | null;
  connect(binding: Binding): Promise<CollaborationConnection | null>;
  exchange?: typeof exchangeWorker;
  history?: AgentHistoryOptions;
  rooms?: { roster(binding: Binding): Record<string, string[]>; allowed(binding: Binding, message: Message): boolean; record(binding: Binding, messages: Message[]): void };
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
  const history = options.history ? new AgentHistoryRelay(`${options.filename}.history`, options.history) : null;
  const historyErrors = new Map<string, string>();
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
          if (history) void history.tick(binding, connection, () => options.peer(binding) !== null).then(
            () => historyErrors.delete(binding.id), () => historyErrors.set(binding.id, 'History relay is unavailable. Retry after checking the worker.'));
          const peers = bindings.filter(b => b.scope === binding.scope).flatMap(b => {
            const peer = options.peer(b); return peer ? [peer] : [];
          });
          const request = mailbox().request(binding, peers, m => options.rooms?.allowed(binding, m) ?? !m.roomId);
          const rooms = options.rooms?.roster(binding) ?? {};
          const response = await (options.exchange ?? exchangeWorker)(connection, { ...request, rooms });
          if (!options.peer(binding)) throw new Error('Agent assignment changed during collaboration.');
          mailbox().accept(binding, response, peers.filter(p => bindings.some(b => b.agentId === p.id && b.scope === binding.scope && options.peer(b))), request.messages.map(m => m.id), m => options.rooms?.allowed(binding, m) ?? !m.roomId);
          // Journal acceptance is authoritative; projection is idempotent and catches up on every exchange.
          options.rooms?.record(binding, mailbox().messages(binding.scope));
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
    error: (id: string) => journalError ?? errors.get(id) ?? historyErrors.get(id) ?? null,
    tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, 2000); timer.unref(); void tick(); } },
    async dispose() { if (timer) clearInterval(timer); timer = null; await flight; await history?.dispose(); },
  };
}
