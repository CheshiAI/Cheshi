export const IMESSAGE_CHANNEL = 'cheshi:imessage';
export type { NotificationKind } from './notification-events.ts';
export interface IMessagePreferences {
  enabled: boolean;
  recipient: string;
}
export interface IMessageSettings extends IMessagePreferences {
  available: boolean;
  lastStatus: string | null;
}
export interface IMessageApi {
  commands?: import('./imessage-commands').IMessageCommandApi;
  get(): Promise<IMessageSettings>;
  save(value: IMessagePreferences): Promise<IMessageSettings>;
  test(): Promise<IMessageSettings>;
  onChanged(listener: (value: IMessageSettings) => void): () => void;
  reportQueue(contextId: string, threads: { threadId: string; count: number }[]): Promise<void>;
}
export const DEFAULT_IMESSAGE_PREFERENCES: IMessagePreferences = {
  enabled: false, recipient: '',
};
export function parseIMessageRecipient(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string') throw new TypeError('Enter an iMessage phone number or email address.');
  const recipient = value.trim();
  if (allowEmpty && !recipient) return '';
  if (recipient.length > 254 || (!/^\+[1-9][0-9]{6,14}$/.test(recipient)
    && !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(recipient))) {
    throw new TypeError('Use an international number such as +821012345678, or an iMessage email address.');
  }
  return recipient;
}
export function parseIMessagePreferences(value: unknown): IMessagePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid iMessage settings.');
  const record = value as Record<string, unknown>;
  for (const key of ['enabled']) {
    if (record[key] !== true && record[key] !== false) throw new TypeError('Invalid iMessage switch value.');
  }
  return { enabled: record.enabled === true, recipient: parseIMessageRecipient(record.recipient, record.enabled === false) };
}
export function parseIMessageSettings(value: unknown): IMessageSettings {
  const preferences = parseIMessagePreferences(value);
  const record = value as Record<string, unknown>;
  if (typeof record.available !== 'boolean' || (record.lastStatus !== null && typeof record.lastStatus !== 'string')) {
    throw new TypeError('Invalid iMessage settings response.');
  }
  return { ...preferences, available: record.available, lastStatus: record.lastStatus as string | null };
}
