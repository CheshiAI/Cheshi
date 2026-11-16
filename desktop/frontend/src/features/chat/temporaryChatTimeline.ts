import type { ChatTimelineItem } from './model';
import type { TemporaryChatMessage } from './temporaryChatSession';
import { displayMessageWithChatImports } from '../../../../shared/chat-imports';

/** Presentation only: never assigns a persisted thread or invokes history APIs. */
export function temporaryChatItems(messages: readonly TemporaryChatMessage[]): ChatTimelineItem[] {
  return messages.map((message, index) => ({
    id: `temporary-${index}`, kind: message.role, createdAt: message.createdAt,
    text: message.attachments.some(file => file.importNumber !== undefined)
      ? displayMessageWithChatImports(message.text, message.attachments)
      : [message.text, ...message.attachments.map(file => `Attached file: ${file.name}`)].filter(Boolean).join('\n\n'),
  }));
}
