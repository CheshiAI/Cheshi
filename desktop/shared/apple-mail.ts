export const MAIL_PAGE_SIZE = 50;
export const MAIL_BODY_LIMIT = 500_000;
export const MAIL_ERRORS = {
  unsupported: 'Apple Mail 연동은 macOS에서 사용할 수 있습니다.',
  permission: '시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Cheshi의 Mail 접근을 허용해 주세요.',
  unavailable: 'Mail에 연결하지 못했습니다. Apple Mail의 계정 상태를 확인한 뒤 다시 시도해 주세요.',
  timeout: 'Mail 응답이 지연되고 있습니다. 권한 요청 창을 확인한 뒤 다시 시도해 주세요.',
  'not-found': '메일 또는 메일함이 이동되거나 없어졌습니다. 새로고침해 주세요.',
  invalid: '메일 조회 요청이 올바르지 않습니다.',
  'invalid-response': 'Mail에서 받은 데이터를 처리하지 못했습니다. 새로고침해 주세요.',
  'too-large': '메일 데이터가 너무 큽니다. 다른 메일함을 선택해 주세요.',
  'send-unknown': '발송 결과를 확인하지 못했습니다. 중복 발송을 막기 위해 다시 보내기를 중지했습니다. Apple Mail의 보낸 편지함과 보낼 편지함을 확인해 주세요.',
  'change-unknown': '변경 결과를 확인하지 못했습니다. 새로고침 후 메일 상태를 확인해 주세요.',
  'ambiguous-mailbox': '같은 이름의 메일함이 여러 개 있습니다. 상위 메일함이 포함된 전체 경로를 선택해 주세요.',
} as const;
export type MailErrorCode = keyof typeof MAIL_ERRORS;
export type MailReply<T> = { ok: true; value: T } | { ok: false; error: { code: MailErrorCode; message: string } };
export interface MailboxRef { accountId: string | null; path: string[] }
export interface Mailbox extends MailboxRef { accountName: string; unread: number }
export interface MailSummary { id: number; subject: string; sender: string; date: string | null; read: boolean; flagged: boolean }
export interface MailPage { messages: MailSummary[]; offset: number; nextOffset: number | null }
export interface MailTarget { mailbox: MailboxRef; id: number }
export interface MailMessage extends MailSummary { body: string; bodyTruncated: boolean; to: string[]; cc: string[]; replyTo: string }
export interface MailAccount { id: string; name: string; addresses: string[] }
export type MailChange = { target: MailTarget } & ({ action: 'read' | 'flag'; value: boolean } | { action: 'move'; destination: MailboxRef });
export interface MailSend {
  operationId: string; accountId: string; sender: string; to: string[]; cc: string[]; bcc: string[];
  subject: string; body: string; reply: { target: MailTarget; all: boolean } | null;
}
export interface MailSent { operationId: string; accepted: true }
export interface AppleMailApi {
  available: boolean;
  mailboxes(): Promise<MailReply<Mailbox[]>>;
  list(mailbox: MailboxRef, offset?: number): Promise<MailReply<MailPage>>;
  read(target: MailTarget): Promise<MailReply<MailMessage>>;
  accounts(): Promise<MailReply<MailAccount[]>>;
  change(input: MailChange): Promise<MailReply<MailTarget>>;
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
    to: mailAddresses(item.to), cc: mailAddresses(item.cc), replyTo: text(item.replyTo, 4096, true) };
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
    body: text(item.body, MAIL_BODY_LIMIT, true), reply: reply ? { target: mailTarget(reply.target), all: flag(reply.all) } : null };
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
