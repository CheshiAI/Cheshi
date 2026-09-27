import type { ChatTimelineItem } from './model';
import type { TemporaryChatMessage } from './temporaryChatSession';

/** Presentation only: never assigns a persisted thread or invokes history APIs. */
export function temporaryChatItems(messages: readonly TemporaryChatMessage[]): ChatTimelineItem[] {
  return messages.map((message, index) => ({
    id: `temporary-${index}`, kind: message.role, createdAt: message.createdAt,
    text: [message.text, ...message.attachments.map(file => `Attached file: ${file.name}`)].filter(Boolean).join('\n\n'),
  }));
}
