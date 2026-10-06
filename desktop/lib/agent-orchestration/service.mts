import { AgentCustomToolRelay, type CustomToolQuery } from './custom-tool-relay.mts';
import { AgentCodeGraphRelay } from './codegraph-relay.mts';
import type { CodeGraphQuery } from './codegraph-source.mts';
import { watchWorker, type WatchWorker } from './worker-events.mts';
import { createEventQueue } from './event-queue.mts';
import { AgentMailbox, type Binding, type Peer, type Message } from './mailbox.mts';
import { AgentHistoryRelay, type AgentHistoryOptions } from './history-relay.mts';
import { workerOperations } from '../agent-management/operations.mts';

export interface CollaborationConnection { endpoint: string; token: string }
interface Options {
  filename: string;
  peer(binding: Binding): Peer | null;
  connect(binding: Binding, demand: boolean): Promise<CollaborationConnection | null>;
  around?(binding: Binding, operation: () => Promise<void>): Promise<void>;
  rest?(binding: Binding, connection: CollaborationConnection, historyBusy: boolean): Promise<void>;
  exchange?: typeof exchangeWorker;
  watch?: WatchWorker;
  changed?(binding: Binding): void;
  nextCheck?(binding: Binding): number | null;
  sleeping?(binding: Binding): boolean;
  history?: AgentHistoryOptions;
  codegraph?: CodeGraphQuery;
  customTools?: CustomToolQuery;
  customToolsAvailable?(binding: Binding): boolean;
  rooms?: { bindings?(): Binding[]; pending?(binding: Binding): boolean; roster(binding: Binding): Record<string, string[]>; allowed(binding: Binding, message: Message): boolean; record(binding: Binding, messages: Message[]): void };
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
  const history = options.history ? new AgentHistoryRelay(`${options.filename}.history`, options.history, binding => notify(binding)) : null;
  const codegraph = options.codegraph ? new AgentCodeGraphRelay(options.codegraph, binding => notify(binding)) : null;
  const customTools = options.customTools ? new AgentCustomToolRelay(options.customTools, binding => notify(binding), undefined, `${options.filename}.custom-tools`) : null;
  const customToolErrors = new Map<string, string>();
  const codegraphErrors = new Map<string, string>();
  const historyErrors = new Map<string, string>();
  let journal: AgentMailbox | null = null;
  const mailbox = () => journal ??= new AgentMailbox(options.filename);
  let journalError: string | null = null;
  const errors = new Map<string, string>();
  let flight: Promise<void> | null = null, started = false;
  const watches = new Map<string, { connection: string; stop(): void }>();
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  const resting = new Set<Promise<void>>();
  const queue = createEventQueue<string>(async id => { await dispatch(id); journalError = null; }, error => { journalError = String(error); });
  function notify(binding?: Binding) {
    try {
      if (binding) { if (!options.peer(binding)) { unwatch(binding.id); return; } mailbox().register(binding); queue.notify(binding.id); }
      else {
        for (const item of options.rooms?.bindings?.() ?? []) mailbox().register(item);
        for (const item of mailbox().bindings()) queue.notify(item.id);
      }
    } catch (error) { journalError = error instanceof Error ? error.message : 'Could not read collaboration journal.'; }
  }
  function unwatch(id: string) { watches.get(id)?.stop(); watches.delete(id); }
  function watch(binding: Binding, connection: CollaborationConnection) {
    if (!started || !options.peer(binding)) return;
    const key = JSON.stringify(connection);
    if (watches.get(binding.id)?.connection === key) return;
    unwatch(binding.id);
    const stop = (options.watch ?? watchWorker)(connection, () => { notify(binding); options.changed?.(binding); }, error => {
      errors.set(binding.id, error.message); options.changed?.(binding);
      // Reconcile a shutdown once; the stream owns bounded reconnect attempts.
      if (!options.sleeping?.(binding)) notify(binding);
    });
    watches.set(binding.id, { connection: key, stop });
  }
  function arm(binding: Binding) {
    clearTimeout(deadlines.get(binding.id)); deadlines.delete(binding.id);
    if (!started || !options.peer(binding)) return;
    const at = options.nextCheck?.(binding);
    if (at == null) return;
    const timer = setTimeout(() => { deadlines.delete(binding.id); notify(binding); }, Math.max(1, Math.min(2_147_483_647, at - Date.now())));
    timer.unref(); deadlines.set(binding.id, timer);
  }
  async function dispatch(only?: string): Promise<void> {
    for (const binding of options.rooms?.bindings?.() ?? []) mailbox().register(binding);
    const bindings = mailbox().bindings();
    for (const binding of bindings) {
      if (only && binding.id !== only) continue;
      try {
        if (!options.peer(binding)) { unwatch(binding.id); clearTimeout(deadlines.get(binding.id)); deadlines.delete(binding.id); continue; }
        const operation = async () => {
          const demand = mailbox().request(binding, [], m => options.rooms?.allowed(binding, m) ?? !m.roomId).messages.length > 0;
          const connection = await options.connect(binding, demand);
          if (!connection) { unwatch(binding.id); return; }
          watch(binding, connection);
          const customToolFlight = (options.customToolsAvailable?.(binding) === false ? undefined : customTools)?.tick(binding, connection, () => options.peer(binding) !== null).then(
            () => customToolErrors.delete(binding.id), () => customToolErrors.set(binding.id, 'Custom tool relay unavailable. Restart the worker.'));
          const codegraphFlight = codegraph?.tick(binding, connection, () => options.peer(binding) !== null).then(
            () => codegraphErrors.delete(binding.id), () => codegraphErrors.set(binding.id, 'CodeGraph relay unavailable. Start the worker to update it.'));
          const historyFlight = history?.tick(binding, connection, () => options.peer(binding) !== null).then(
            () => historyErrors.delete(binding.id), () => historyErrors.set(binding.id, 'History relay is unavailable. Retry after checking the worker.'));
          const peers = bindings.filter(b => b.scope === binding.scope).flatMap(b => {
            const peer = options.peer(b); return peer ? [peer] : [];
          });
          const request = mailbox().request(binding, peers, m => options.rooms?.allowed(binding, m) ?? !m.roomId);
          const rooms = options.rooms?.roster(binding) ?? {};
          const response = await (options.exchange ?? exchangeWorker)(connection, { ...request, rooms });
          if (!options.peer(binding)) throw new Error('Agent assignment changed during collaboration.');
          const before = JSON.stringify(mailbox().messages(binding.scope));
          mailbox().accept(binding, response, peers.filter(p => bindings.some(b => b.agentId === p.id && b.scope === binding.scope && options.peer(b))), request.messages.map(m => m.id), m => options.rooms?.allowed(binding, m) ?? !m.roomId);
          // Journal acceptance is authoritative; projection is idempotent and catches up on every exchange.
          options.rooms?.record(binding, mailbox().messages(binding.scope));
          if (before !== JSON.stringify(mailbox().messages(binding.scope))) {
            for (const peer of bindings.filter(b => b.scope === binding.scope && b.id !== binding.id)) {
              if (mailbox().request(peer, [], m => options.rooms?.allowed(peer, m) ?? !m.roomId).messages.length) notify(peer);
            }
          }
          errors.delete(binding.id);
          const rest = async () => {
            await options.rest?.(binding, connection, (history?.busy ?? false) || (codegraph?.busy ?? false) || (customTools?.busy ?? false));
            if (options.sleeping?.(binding)) unwatch(binding.id);
          };
          if ((historyFlight || codegraphFlight || customToolFlight) && options.rest) {
            // Read-only tool transport must not hold up collaboration or coordinator shutdown.
            const idle = Promise.all([historyFlight, codegraphFlight, customToolFlight]).then(async () => {
              if (!started || !options.peer(binding)) return;
              await workerOperations.run(() => options.around ? options.around(binding, rest) : rest());
              arm(binding);
            }).catch(error => { errors.set(binding.id, String(error)); }).finally(() => { resting.delete(idle); });
            resting.add(idle);
          } else await rest();
        };
        await workerOperations.run(() => options.around ? options.around(binding, operation) : operation());
      } catch (error) { errors.set(binding.id, error instanceof Error ? error.message : 'Collaboration failed.'); }
      finally { arm(binding); }
    }
  }
  const tick = (): Promise<void> => {
    flight ??= dispatch().then(() => { journalError = null; }, error => {
      journalError = error instanceof Error ? error.message : 'Could not read collaboration journal.';
    }).finally(() => { flight = null; });
    return flight;
  };
  return {
    pending: (binding: Binding) => mailbox().request(binding, [], m => options.rooms?.allowed(binding, m) ?? !m.roomId).messages.length > 0,
    register: (binding: Binding) => mailbox().register(binding),
    error: (id: string) => journalError ?? errors.get(id) ?? historyErrors.get(id) ?? customToolErrors.get(id) ?? codegraphErrors.get(id) ?? null,
    tick, notify, settled: () => queue.settled(),
    start() { if (!started) { started = true; notify(); queue.start(); } },
    async dispose() { started = false; for (const w of watches.values()) w.stop(); watches.clear();
      for (const timer of deadlines.values()) clearTimeout(timer); deadlines.clear();
      await customTools?.dispose(); await codegraph?.dispose(); await history?.dispose(); await queue.dispose(); await flight; await Promise.allSettled(resting); },
  };
}
