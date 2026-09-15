import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { dirname, join } from 'node:path';
import { createEditorSessionIpc } from './editor-session-ipc.mts';
import { createChatQuestionDismissalsIpc } from './chat-question-dismissals-ipc.mts';

export function createWorkspaceSessionStores(
  ipc: Pick<IpcMain, 'handle'>, codeGraphDirectory: string, assertSender: (event: IpcMainInvokeEvent) => void,
) {
  const directory = dirname(codeGraphDirectory);
  const editor = createEditorSessionIpc(ipc, directory, assertSender);
  const questions = createChatQuestionDismissalsIpc(ipc, join(directory, 'chat-question-dismissals'), assertSender);
  return { async flush() { await Promise.all([editor.flush(), questions.flush()]); } };
}
