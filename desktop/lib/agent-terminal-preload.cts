import type { IpcRenderer } from 'electron';
import { AGENT_TERMINAL_CHANNELS, parseAgentTerminalBounds, parseAgentTerminalSession } from '../shared/agent-terminal.ts';
import type { AgentTerminalApi } from '../shared/agent-terminal.ts';
import { agentText, parseAgentEngineId, parseAgentId } from '../shared/agent-management.ts';

export function createAgentTerminalApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): AgentTerminalApi {
  return {
    async open(engine, id) { return parseAgentTerminalSession(await ipc.invoke(AGENT_TERMINAL_CHANNELS.open, parseAgentEngineId(engine), parseAgentId(id))); },
    async update(bounds) { await ipc.invoke(AGENT_TERMINAL_CHANNELS.update, parseAgentTerminalBounds(bounds)); },
    async close(id) { await ipc.invoke(AGENT_TERMINAL_CHANNELS.close, agentText(id, 100)); },
    onChanged(listener) {
      const receive = (_event: unknown, value: unknown) => listener(parseAgentTerminalSession(value));
      ipc.on(AGENT_TERMINAL_CHANNELS.changed, receive);
      return () => { ipc.removeListener(AGENT_TERMINAL_CHANNELS.changed, receive); };
    },
  };
}
