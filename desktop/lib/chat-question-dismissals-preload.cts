import type { IpcRenderer } from 'electron';
import { questionDismissal, questionThreadId } from '../shared/chat-question-dismissals.ts';
import type { ChatQuestionDismissalsApi } from '../shared/chat-question-dismissals.ts';

export function createChatQuestionDismissalsApi(ipc: Pick<IpcRenderer, 'invoke'>): ChatQuestionDismissalsApi {
  return {
    async list(threadId) {
      const value: unknown = await ipc.invoke('cheshi:list-chat-question-dismissals', questionThreadId(threadId));
      if (!Array.isArray(value)) throw new TypeError('Invalid question dismissals response.');
      return value.map(questionDismissal);
    },
    async save(threadId, record) {
      const input = questionDismissal(record);
      const saved = questionDismissal(await ipc.invoke('cheshi:save-chat-question-dismissal', questionThreadId(threadId), input));
      if (saved.questionId !== input.questionId || saved.action !== input.action
        || saved.turnId !== input.turnId || saved.itemId !== input.itemId) throw new TypeError('Invalid question dismissal acknowledgement.');
      return saved;
    },
  };
}
