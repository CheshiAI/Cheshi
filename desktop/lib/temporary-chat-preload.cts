import type { IpcRenderer } from 'electron';
import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop.ts';
import { readTemporaryChatReply } from '../shared/temporary-chat.ts';

export function createTemporaryChatApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>,
  getPathForFile: (file: File) => string,
): CheshiDesktopApi['temporaryChat'] {
  const invoke = async <T,>(channel: string, ...args: unknown[]): Promise<T> => (
    readTemporaryChatReply<T>(await ipc.invoke(channel, ...args))
  );
  return {
    openWindow: draft => ipc.invoke('cheshi:temporary-chat-open-window', draft),
    initialDraft: () => ipc.invoke('cheshi:temporary-chat-initial-draft'),
    acceptDraft: error => ipc.invoke('cheshi:temporary-chat-accept-draft', error),
    onOpened: listener => {
      const handler = () => listener();
      ipc.on('cheshi:temporary-chat-opened', handler);
      return () => { ipc.removeListener('cheshi:temporary-chat-opened', handler); };
    },
    isWindowOpen: () => ipc.invoke('cheshi:temporary-chat-window-state'),
    onWindowChanged: listener => {
      const handler = (_event: unknown, open: unknown) => listener(open === true);
      ipc.on('cheshi:temporary-chat-window-changed', handler);
      return () => { ipc.removeListener('cheshi:temporary-chat-window-changed', handler); };
    },
    models: sessionId => invoke('cheshi:temporary-chat-models', sessionId),
    send: (sessionId, request) => invoke('cheshi:temporary-chat-send', sessionId, request),
    selectAttachments: sessionId => invoke('cheshi:temporary-chat-attachments', sessionId),
    importAttachments: (sessionId, files) => {
      if (!Array.isArray(files) || files.length > 20) throw new TypeError('Attach up to 20 files per message.');
      const paths = files.map(file => typeof file === 'string' ? file : getPathForFile(file));
      return invoke('cheshi:temporary-chat-import-attachments', sessionId, paths);
    },
    close: sessionId => ipc.invoke('cheshi:temporary-chat-close', sessionId),
  };
}
