import type { IpcRenderer } from 'electron';
import { HOST_TOOL_DETAILS_CHANNEL, hostToolDetailsReplyChannel, parseHostToolDetails, type HostToolDetailsListener } from '../shared/host-tool-details.ts';

export function onHostToolDetails(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>, listener: HostToolDetailsListener) {
  const pending = new Map<string, (back: boolean) => void>();
  const receive = (_event: unknown, value: unknown) => {
    const details = parseHostToolDetails(value);
    const result = listener(details);
    if (!result || pending.has(details.token)) return;
    const reply = (back: boolean) => {
      if (!pending.delete(details.token)) return;
      void ipc.invoke(hostToolDetailsReplyChannel(details.token), back === true).catch(() => {});
    };
    pending.set(details.token, reply);
    void result.then(back => reply(back === true), () => reply(false));
  };
  ipc.on(HOST_TOOL_DETAILS_CHANNEL, receive);
  return () => {
    ipc.removeListener(HOST_TOOL_DETAILS_CHANNEL, receive);
    for (const reply of pending.values()) reply(false);
  };
}
