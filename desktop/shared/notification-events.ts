export const NOTIFICATION_EVENTS_CHANNEL = 'cheshi:notification-events';
export const NOTIFICATION_KINDS = ['completed', 'attention', 'failed'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationEventPreferences = Record<NotificationKind, boolean>;
export interface NotificationEventSettings extends NotificationEventPreferences { error: string | null; }
export interface NotificationEventsApi {
  reportView(contextId: string, threadId: string | null): Promise<void>;
  get(): Promise<NotificationEventSettings>;
  set(kind: NotificationKind, enabled: boolean): Promise<NotificationEventSettings>;
  onChanged(listener: (value: NotificationEventSettings) => void): () => void;
}
export interface NotificationPolicy {
  allows(kind: NotificationKind): boolean;
  subscribe(listener: () => void): () => void;
}
export const DEFAULT_NOTIFICATION_EVENTS: NotificationEventPreferences = { completed: true, attention: true, failed: true };
export function parseNotificationEvents(value: unknown): NotificationEventPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid notification events.');
  const data = value as Record<string, unknown>;
  for (const kind of NOTIFICATION_KINDS) if (typeof data[kind] !== 'boolean') throw new TypeError('Invalid notification switch.');
  return { completed: data.completed === true, attention: data.attention === true, failed: data.failed === true };
}
export function parseNotificationEventSettings(value: unknown): NotificationEventSettings {
  const preferences = parseNotificationEvents(value);
  const { error } = value as Record<string, unknown>;
  if (error !== null && typeof error !== 'string') throw new TypeError('Invalid notification status.');
  return { ...preferences, error };
}
