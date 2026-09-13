import type { ChatSavedTurnInput } from '../../../../shared/chat-saved-turns';
import { parseChatRelayMessage } from '../../../../shared/chat-relay';
import { parseSavedChatTurnPrompt, savedChatTurnDisplayText } from '../../../../shared/chat-saved-turn-continuation';
import { relayAssistantDisplayText, relayDisplayText } from './chatRelayMessageView';
import type { ChatTimelineItem } from './model';

/** Key action rows by the final timeline item, preserving the saved response identity. */
export function completedChatTurnInputs(
  items: ChatTimelineItem[], threadId: string | null, sessionTitle: string, responding: boolean,
): Map<string, ChatSavedTurnInput> {
  const turns = new Map<string, ChatSavedTurnInput>();
  if (!threadId) return turns;
  let userText = '';
  let responses: string[] = [];
  let lastAssistant: Extract<ChatTimelineItem, { text: string }> | undefined;
  let lastItemId: string | undefined;
  const finish = () => {
    if (!lastAssistant || !lastItemId || responses.length === 0) return;
    turns.set(lastItemId, { threadId, itemId: lastAssistant.id, sessionTitle, userText,
      assistantText: responses.join('\n\n'), createdAt: lastAssistant.createdAt });
  };
  for (const item of items) {
    if (item.kind === 'user') {
      finish();
      const relay = parseChatRelayMessage(item.text);
      const savedTurn = relay ? null : parseSavedChatTurnPrompt(item.text);
      userText = relay ? relayDisplayText(relay) : savedTurn ? savedChatTurnDisplayText(savedTurn) : item.text;
      responses = [];
      lastAssistant = undefined;
      lastItemId = undefined;
    } else if (item.kind === 'assistant' || item.kind === 'plan') {
      const text = relayAssistantDisplayText(item.text, false);
      if (text.trim()) {
        responses.push(text);
        lastAssistant = item;
      }
    }
    if (item.kind !== 'user') lastItemId = item.id;
  }
  if (!responding) finish();
  return turns;
}
