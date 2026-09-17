import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { AUTOPILOT_CHANNELS, parseAutopilotRequest, parseAutopilotState, parseAutopilotView, parseAutopilotReportFormat } from '../shared/autopilot.ts';
import type { AutopilotApi } from '../shared/autopilot.ts';

export function createAutopilotApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): AutopilotApi {
  return {
    async getState() { return parseAutopilotState(await ipc.invoke(AUTOPILOT_CHANNELS.get)); },
    async start(request) { return parseAutopilotState(await ipc.invoke(AUTOPILOT_CHANNELS.start, parseAutopilotRequest(request))); },
    async stop() { return parseAutopilotState(await ipc.invoke(AUTOPILOT_CHANNELS.stop)); },
    async exportReport(format) {
      const request = parseAutopilotReportFormat(format);
      const result: unknown = await ipc.invoke(AUTOPILOT_CHANNELS.export, request);
      if (result !== true && result !== false) throw new TypeError('Invalid report save result.');
      return result;
    },
    async setView(request) { await ipc.invoke(AUTOPILOT_CHANNELS.view, parseAutopilotView(request)); },
    onState(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => handler(parseAutopilotState(value));
      ipc.on(AUTOPILOT_CHANNELS.state, listener);
      return () => { ipc.removeListener(AUTOPILOT_CHANNELS.state, listener); };
    },
  };
}
