import { mailboxKey, mailSummary, mailTarget } from './apple-mail.ts';
import type { MailSummary, MailTarget } from './apple-mail.ts';

export const MAIL_CONVERSATION_LIMIT = 50;
export interface MailConversationEntry { target: MailTarget; summary: MailSummary }
export interface MailConversation { messages: MailConversationEntry[]; incomplete: boolean }
export function mailTargetKey(target: MailTarget): string { return `${mailboxKey(target.mailbox)}:${target.id}`; }

export function mailConversation(value: unknown, anchor: MailTarget): MailConversation {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid conversation');
  const item = value as Record<string, unknown>;
  if (!Array.isArray(item.messages) || item.messages.length === 0 || item.messages.length > MAIL_CONVERSATION_LIMIT
    || (item.incomplete !== true && item.incomplete !== false)) throw new TypeError('Invalid conversation');
  const seen = new Set<string>();
  const messages = item.messages.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('Invalid conversation entry');
    const row = entry as Record<string, unknown>;
    const target = mailTarget(row.target);
    const summary = mailSummary(row.summary);
    const key = mailTargetKey(target);
    if (target.mailbox.accountId !== anchor.mailbox.accountId || summary.id !== target.id || seen.has(key)) {
      throw new TypeError('Unexpected conversation target');
    }
    seen.add(key);
    return { target, summary };
  });
  if (!seen.has(mailTargetKey(anchor))) throw new TypeError('Missing conversation anchor');
  return { messages, incomplete: item.incomplete };
}
