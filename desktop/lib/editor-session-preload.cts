import type { IpcRenderer } from 'electron';
import { parseEditorSession, type EditorSessionApi } from '../shared/editor-session.ts';

export function createEditorSessionApi(ipc: Pick<IpcRenderer, 'invoke'>): EditorSessionApi {
  return {
    async read() {
      const value: unknown = await ipc.invoke('cheshi:read-editor-session');
      return value === null ? null : parseEditorSession(value);
    },
    async save(session) { await ipc.invoke('cheshi:save-editor-session', parseEditorSession(session)); },
  };
}
