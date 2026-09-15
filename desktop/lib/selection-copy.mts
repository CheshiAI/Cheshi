import type { Clipboard, IpcMainEvent, WebContents } from 'electron';

export function registerSelectionCopy(contents: WebContents, clipboard: Pick<Clipboard, 'writeText'>): void {
  const receive = (event: IpcMainEvent, channel: string, text: unknown) => {
    if (channel !== 'cheshi:copy-drag-selection' || contents.isDestroyed() || !contents.isFocused()
      || event.senderFrame !== contents.mainFrame || typeof text !== 'string' || text.length === 0) return;
    try { clipboard.writeText(text); } catch { /* A clipboard failure must not affect the page. */ }
  };
  contents.on('ipc-message', receive);
  contents.once('destroyed', () => contents.removeListener('ipc-message', receive));
}
