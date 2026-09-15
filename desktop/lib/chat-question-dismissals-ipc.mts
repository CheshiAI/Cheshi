import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ChatQuestionDismissals } from './chat-question-dismissals.mts';

export function createChatQuestionDismissalsIpc(
  ipc: Pick<IpcMain, 'handle'>, directory: string, assertSender: (event: IpcMainInvokeEvent) => void,
) {
  const store = new ChatQuestionDismissals(directory);
  registerChatQuestionDismissalsIpc({ ipc, store, assertSender });
  return store;
}

export function registerChatQuestionDismissalsIpc({ ipc, store, assertSender }: {
  ipc: Pick<IpcMain, 'handle'>;
  store: Pick<ChatQuestionDismissals, 'list' | 'save'>;
  assertSender(event: IpcMainInvokeEvent): void;
}) {
  ipc.handle('cheshi:list-chat-question-dismissals', (event, threadId) => {
    assertSender(event);
    return store.list(threadId);
  });
  ipc.handle('cheshi:save-chat-question-dismissal', (event, threadId, record) => {
    assertSender(event);
    return store.save(threadId, record);
  });
}
