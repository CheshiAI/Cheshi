import type { ChatSavedTurn } from '../../../../shared/chat-saved-turns';
import { formatSavedChatTurnPrompt } from '../../../../shared/chat-saved-turn-continuation';
import type { CheshiDesktopApi } from '../../cheshiDesktop';

type ContinuationApi = Pick<CheshiDesktopApi, 'newCodexChatSession' | 'sendCodexChatMessage'>;

export function savedChatTurnPrompt(record: ChatSavedTurn): string {
  return formatSavedChatTurnPrompt(record);
}

export async function continueSavedChatTurn(
  api: ContinuationApi,
  record: ChatSavedTurn,
  contextId: string | undefined,
  clientMessageId: string,
  onSessionReady: (text: string) => boolean,
): Promise<unknown> {
  const text = savedChatTurnPrompt(record);
  if (new TextEncoder().encode(text).byteLength > 512 * 1024) {
    throw new Error('This saved turn is too large to send in a new session (512 KB maximum).');
  }
  await api.newCodexChatSession(contextId);
  if (!onSessionReady(text)) return null;
  // Explicitly target a fresh thread, never the previously viewed session.
  return api.sendCodexChatMessage(text, clientMessageId, null, [], null, contextId);
}
