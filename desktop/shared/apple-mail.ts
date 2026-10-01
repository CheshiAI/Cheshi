import type { MailReplyEditingRequest, MailReplyEditingResult } from './mail-reply.ts';

export const MAIL_PAGE_SIZE = 25;
export const MAIL_BODY_LIMIT = 500_000;
export const MAIL_SOURCE_LIMIT = 2_000_000;
export const MAIL_INLINE_IMAGE_LIMIT = 2_000_000;
export const MAIL_INLINE_IMAGE_COUNT = 32;
export const MAIL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;
export const MAIL_ERRORS = {
  unsupported: 'Apple Mail integration is available on macOS.',
  permission: 'Allow Cheshi to access Mail in System Settings → Privacy & Security → Automation.',
  unavailable: 'Could not connect to Mail. Check your accounts in Apple Mail and try again.',
  timeout: 'Mail is taking too long to respond. Check for a permission prompt and try again.',
  'not-found': 'The message or mailbox was moved or no longer exists. Please refresh.',
  invalid: 'The mail request is invalid.',
  'invalid-response': 'Could not process the data from Mail. Please refresh.',
  'too-large': 'The mail data is too large. Select another mailbox.',
  accessibility: 'Allow Cheshi in System Settings → Privacy & Security → Accessibility, then try again.',
  'editing-failed': 'The mail assistant could not finish editing. Your draft has been kept. Check your Codex account and try again.',
  'preparation-failed': 'Mail could not prepare the formatted message. Your draft has been kept. Check the open Mail window before trying again.',
  busy: 'Another formatted message is being prepared. Please try again when it finishes.',
  'send-unknown': 'The send result could not be confirmed. Sending again is disabled to prevent duplicates. Check Sent and Outbox in Apple Mail.',
  'change-unknown': 'The change could not be confirmed. Refresh and check the message status.',
  'ambiguous-mailbox': 'Multiple mailboxes have the same name. Select the full path, including parent mailboxes.',
} as const;
export type MailErrorCode = keyof typeof MAIL_ERRORS;
export type MailReply<T> = { ok: true; value: T } | { ok: false; error: { code: MailErrorCode; message: string } };
export interface MailboxRef { accountId: string | null; path: string[] }
export interface Mailbox extends MailboxRef { accountName: string; unread: number }
export interface MailSummary { id: number; subject: string; sender: string; date: string | null; read: boolean; flagged: boolean }
export interface MailPage { messages: MailSummary[]; offset: number; nextOffset: number | null }
export interface MailTarget { mailbox: MailboxRef; id: number }
export interface MailInlineImage { contentId: string; mimeType: string; base64: string }
export interface MailMessage extends MailSummary {
  body: string; bodyTruncated: boolean; to: string[]; cc: string[]; replyTo: string;
  html?: string; inlineImages?: MailInlineImage[];
}
export interface MailAccount { id: string; name: string; addresses: string[] }
export type MailChange = { target: MailTarget } & ({ action: 'read' | 'flag'; value: boolean } | { action: 'move'; destination: MailboxRef });
export interface MailSend {
  operationId: string; accountId: string; sender: string; to: string[]; cc: string[]; bcc: string[];
  subject: string; body: string; html?: string; reply: { target: MailTarget; all: boolean } | null;
}
export interface MailSent { operationId: string; accepted: true }
export interface AppleMailApi {
  available: boolean;
  mailboxes(): Promise<MailReply<Mailbox[]>>;
  list(mailbox: MailboxRef, offset?: number): Promise<MailReply<MailPage>>;
  read(target: MailTarget): Promise<MailReply<MailMessage>>;
  accounts(): Promise<MailReply<MailAccount[]>>;
  change(input: MailChange): Promise<MailReply<MailTarget>>;
  polish(input: MailReplyEditingRequest): Promise<MailReply<MailReplyEditingResult>>;
  send(input: MailSend): Promise<MailReply<MailSent>>;
}
export function mailFailure<T>(code: MailErrorCode): MailReply<T> {
  return { ok: false, error: { code, message: MAIL_ERRORS[code] } };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Mail object');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || value.includes('\0')) {
    throw new TypeError('Invalid Mail text');
  }
  return value;
}
function flag(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid Mail flag');
  return value;
}
export function mailOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Mail offset');
  return value;
}
function messageId(value: unknown): number {
  const id = mailOffset(value);
  if (id === 0) throw new TypeError('Invalid Mail identifier');
  return id;
}
export function mailboxRef(value: unknown): MailboxRef {
  const item = record(value);
  if (!Array.isArray(item.path) || item.path.length === 0 || item.path.length > 32) throw new TypeError('Invalid mailbox path');
  return { accountId: item.accountId === null ? null : text(item.accountId, 4096), path: item.path.map(part => text(part, 4096)) };
}
export function mailboxKey(mailbox: MailboxRef): string { return JSON.stringify([mailbox.accountId, mailbox.path]); }
export function mailboxes(value: unknown): Mailbox[] {
  if (!Array.isArray(value) || value.length > 5000) throw new TypeError('Invalid mailbox list');
  const seen = new Set<string>();
  return value.map(entry => {
    const item = record(entry);
    const box = { ...mailboxRef(item), accountName: text(item.accountName, 4096, true), unread: mailOffset(item.unread) };
    const key = mailboxKey(box);
    if (seen.has(key)) throw new TypeError('Duplicate mailbox');
    seen.add(key);
    return box;
  });
}
export function mailSummary(value: unknown): MailSummary {
  const item = record(value);
  const date = item.date === null ? null : text(item.date, 64);
  if (date !== null && !Number.isFinite(Date.parse(date))) throw new TypeError('Invalid Mail date');
  return { id: messageId(item.id), subject: text(item.subject, 10_000, true), sender: text(item.sender, 4096, true),
    date, read: flag(item.read), flagged: flag(item.flagged) };
}
export function mailPage(value: unknown, expectedOffset: number): MailPage {
  const item = record(value);
  if (!Array.isArray(item.messages) || item.messages.length > MAIL_PAGE_SIZE) throw new TypeError('Invalid Mail page');
  const messages = item.messages.map(mailSummary);
  if (new Set(messages.map(message => message.id)).size !== messages.length) throw new TypeError('Duplicate message');
  const offset = mailOffset(item.offset);
  const nextOffset = item.nextOffset === null ? null : mailOffset(item.nextOffset);
  if (offset !== expectedOffset || (nextOffset !== null && (messages.length !== MAIL_PAGE_SIZE || nextOffset !== offset + messages.length))) {
    throw new TypeError('Invalid Mail pagination');
  }
  return { messages, offset, nextOffset };
}
export function mailTarget(value: unknown): MailTarget {
  const item = record(value);
  return { mailbox: mailboxRef(item.mailbox), id: messageId(item.id) };
}
export function mailMessage(value: unknown, expectedId: number): MailMessage {
  const item = record(value);
  const summary = mailSummary(item);
  if (summary.id !== expectedId) throw new TypeError('Unexpected Mail message');
  return { ...summary, body: text(item.body, MAIL_BODY_LIMIT, true), bodyTruncated: flag(item.bodyTruncated),
    to: mailAddresses(item.to), cc: mailAddresses(item.cc), replyTo: text(item.replyTo, 4096, true),
    ...(item.html === undefined ? {} : { html: text(item.html, MAIL_BODY_LIMIT, true) }),
    ...(item.inlineImages === undefined ? {} : { inlineImages: mailInlineImages(item.inlineImages) }) };
}
function mailInlineImages(value: unknown): MailInlineImage[] {
  if (!Array.isArray(value) || value.length > MAIL_INLINE_IMAGE_COUNT) throw new TypeError('Invalid inline images');
  const seen = new Set<string>();
  let size = 0;
  return value.map(entry => {
    const item = record(entry);
    const contentId = text(item.contentId, 4096);
    const mimeType = text(item.mimeType, 64);
    const base64 = text(item.base64, MAIL_INLINE_IMAGE_LIMIT);
    size += base64.length;
    if (seen.has(contentId) || size > MAIL_INLINE_IMAGE_LIMIT
      || !MAIL_IMAGE_TYPES.some(type => type === mimeType)
      || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new TypeError('Invalid inline image');
    }
    seen.add(contentId);
    return { contentId, mimeType, base64 };
  });
}
export function mailAddress(value: unknown): string {
  const address = text(value, 320).trim();
  if (!/^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(address)) throw new TypeError('Invalid email address');
  return address;
}
export function mailAddresses(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new TypeError('Invalid email recipients');
  return value.map(entry => text(entry, 4096, true));
}
export function mailAccounts(value: unknown): MailAccount[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid Mail accounts');
  return value.map(entry => { const item = record(entry); return { id: text(item.id, 4096), name: text(item.name, 4096, true),
    addresses: mailAddresses(item.addresses).map(mailAddress) }; });
}
export function mailChange(value: unknown): MailChange {
  const item = record(value);
  const target = mailTarget(item.target);
  if (item.action === 'move') {
    const destination = mailboxRef(item.destination);
    if (mailboxKey(target.mailbox) === mailboxKey(destination)) throw new TypeError('Same mailbox');
    return { action: 'move', target, destination };
  }
  if (item.action !== 'read' && item.action !== 'flag') throw new TypeError('Invalid Mail change');
  return { action: item.action, target, value: flag(item.value) };
}
export function mailSend(value: unknown): MailSend {
  const item = record(value);
  const operationId = text(item.operationId, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) throw new TypeError('Invalid send identifier');
  const to = mailAddresses(item.to).map(mailAddress), cc = mailAddresses(item.cc).map(mailAddress), bcc = mailAddresses(item.bcc).map(mailAddress);
  if (to.length + cc.length + bcc.length === 0 || to.length + cc.length + bcc.length > 100) throw new TypeError('Invalid recipient count');
  const subject = text(item.subject, 1000, true);
  if (/[\r\n]/.test(subject)) throw new TypeError('Invalid subject');
  const reply = item.reply === null ? null : record(item.reply);
  return { operationId, accountId: text(item.accountId, 4096), sender: mailAddress(item.sender), to, cc, bcc, subject,
    body: text(item.body, MAIL_BODY_LIMIT, true),
    ...(item.html === undefined ? {} : { html: text(item.html, MAIL_SOURCE_LIMIT + MAIL_INLINE_IMAGE_LIMIT, true) }), reply: reply ? { target: mailTarget(reply.target), all: flag(reply.all) } : null };
}
export function mailSent(value: unknown, operationId: string): MailSent {
  const item = record(value);
  if (item.operationId !== operationId || item.accepted !== true) throw new TypeError('Unconfirmed Mail send');
  return { operationId, accepted: true };
}
export function mailChanged(value: unknown, target: MailTarget): MailTarget {
  const result = mailTarget(value);
  if (result.id !== target.id || mailboxKey(result.mailbox) !== mailboxKey(target.mailbox)) throw new TypeError('Unexpected Mail change');
  return result;
}
export function mailReply<T>(value: unknown, parse: (value: unknown) => T): MailReply<T> {
  const reply = record(value);
  if (reply.ok === true) return { ok: true, value: parse(reply.value) };
  const error = record(reply.error);
  if (reply.ok !== false || typeof error.code !== 'string' || !Object.hasOwn(MAIL_ERRORS, error.code)) throw new TypeError('Invalid Mail reply');
  return mailFailure(error.code as MailErrorCode);
}
