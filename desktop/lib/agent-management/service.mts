import { agentBoolean, agentNullableText, agentRecord, parseAgentAction, parseAgentEngineId, parseAgentId,
  parseAgentTasks } from '../../shared/agent-management.ts';
import type { AgentCatalog, AgentDetails, AgentManagementApi, AgentSnapshot } from '../../shared/agent-management.ts';
import type { AgentEngine, RuntimeAgent } from './engine.mts';

type WorkerPath = '/health' | '/account' | '/activity';
export type ReadWorker = (endpoint: string, path: WorkerPath) => Promise<unknown>;
export const readWorker: ReadWorker = async (endpoint, path) => {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Worker API must use a published loopback port.');
  }
  const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok && !(path === '/health' && response.status === 503)) throw new Error('Worker API is unavailable.');
  if (!response.body) throw new Error('Worker API returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Worker response exceeds the inspection limit.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); }
};

function health(value: unknown) {
  const data = agentRecord(value);
  if (!['verifier', 'planning', 'research', 'frontend', 'development', 'verification', 'custom'].includes(String(data.role))) throw new Error('Unexpected worker role.');
  return { ready: agentBoolean(data.ready), busy: agentBoolean(data.busy),
    threadId: agentNullableText(data.threadId), error: agentNullableText(data.error, 20_000) };
}
function assertIdle(busy: boolean): void {
  if (busy) throw new Error('The worker is busy. Wait for its task to finish before stopping or restarting.');
}
function publicAgent({ endpoint: _endpoint, ...agent }: RuntimeAgent) { return agent; }

export function createAgentManagementService(options: { engines: AgentEngine[]; read?: ReadWorker }): AgentManagementApi {
  const adapters = new Map(options.engines.map(engine => [engine.kind, engine]));
  const pending = new Set<string>();
  const read = options.read ?? readWorker;
  const adapter = (input: string) => {
    const id = parseAgentEngineId(input);
    const found = adapters.get(id.split(':')[0]!);
    if (!found) throw new Error('Unsupported execution engine.');
    return found;
  };
  const snapshot = async (engineId: string): Promise<AgentSnapshot> => {
    const engine = adapter(engineId);
    try { return { engineId, online: true, error: null, agents: await engine.list(engineId) }; }
    catch { return { engineId, online: false, error: 'Engine unavailable. Start the selected engine, then refresh.', agents: [] }; }
  };
  return {
    async engines(): Promise<AgentCatalog> {
      const results = await Promise.allSettled(options.engines.map(engine => engine.engines()));
      return { engines: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
        error: results.some(result => result.status === 'rejected') ? 'Could not list engines. Check the Docker CLI installation.' : null };
    },
    snapshot,
    async details(engineId, agentId): Promise<AgentDetails> {
      const engine = adapter(engineId);
      const agent = await engine.inspect(engineId, parseAgentId(agentId));
      const result: AgentDetails = { agent: publicAgent(agent), ready: false, busy: false, authenticated: null,
        threadId: null, error: null, logs: '', tasks: [] };
      const notices: string[] = [];
      const logs = engine.logs(engineId, agent.id).then(value => { result.logs = value; }, () => { notices.push('Could not read worker logs.'); });
      if (agent.state === 'running' && agent.endpoint) {
        await Promise.all([
          read(agent.endpoint, '/health').then(value => {
            const state = health(value);
            Object.assign(result, { ready: state.ready, busy: state.busy, threadId: state.threadId });
            if (state.error) notices.push('Worker reported an error. Inspect its logs.');
          }).catch(() => { notices.push('Worker health is unavailable.'); }),
          read(agent.endpoint, '/account').then(value => {
            result.authenticated = agentBoolean(agentRecord(value).authenticated);
          }).catch(() => { notices.push('Login status is unavailable.'); }),
          read(agent.endpoint, '/activity').then(value => {
            result.tasks = parseAgentTasks(agentRecord(value).tasks).slice(-100).reverse();
          }).catch(() => { notices.push('Task history is unavailable or exceeds the inspection limit.'); }),
        ]);
      } else if (agent.state === 'running') notices.push('Worker API needs one port bound to 127.0.0.1.');
      await logs;
      result.error = notices.length ? notices.join(' ') : null;
      return result;
    },
    async control(engineId, agentId, input) {
      const engine = adapter(engineId), id = parseAgentId(agentId), action = parseAgentAction(input);
      const key = `${engineId}/${id}`;
      if (pending.has(key)) throw new Error('A worker operation is already running.');
      pending.add(key);
      try {
        const agent = await engine.inspect(engineId, id);
        if (action !== 'start') {
          if (!agent.endpoint) throw new Error('Cannot verify worker activity. No loopback API is available.');
          let busy: boolean;
          try { busy = health(await read(agent.endpoint, '/health')).busy; }
          catch { throw new Error('Cannot verify worker activity. Refresh before stopping or restarting.'); }
          assertIdle(busy);
        }
        await engine.control(engineId, id, action);
        return await snapshot(engineId);
      } finally { pending.delete(key); }
    },
  };
}
