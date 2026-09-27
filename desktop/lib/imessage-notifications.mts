import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_IMESSAGE_PREFERENCES, parseIMessagePreferences, parseIMessageRecipient,
  type IMessageSettings, type NotificationKind } from '../shared/imessage-notifications.ts';
import { sendIMessage } from './imessage-process.mts';
import { NOTIFICATION_KINDS, type NotificationPolicy } from '../shared/notification-events.ts';

export interface ChatNotification { kind: NotificationKind; workspace: string; conversation: string; }
export interface NotificationSink { notify(event: ChatNotification): void; }
/** App-wide settings and bounded, serialized delivery; notification failures never fail chat work. */
export function createIMessageNotifications(options: {
  filename: string; platform?: string;
  events?: NotificationPolicy;
  send?: (recipient: string, text: string, signal: AbortSignal) => Promise<void>;
}) {
  let preferences = { ...DEFAULT_IMESSAGE_PREFERENCES };
  let lastStatus: string | null = null;
  const available = (options.platform ?? process.platform) === 'darwin';
  const listeners = new Set<(state: IMessageSettings) => void>();
  let revision = 0, closed = false, pending = 0;
  let current: AbortController | null = null;
  let currentKind: NotificationKind | undefined;
  const versions = { completed: 0, attention: 0, failed: 0 };
  const allows = (kind: NotificationKind) => options.events?.allows(kind) ?? true;
  const unsubscribe = options.events?.subscribe(() => {
    for (const kind of NOTIFICATION_KINDS) if (!allows(kind)) {
      versions[kind]++;
      if (currentKind === kind) current?.abort();
    }
  });
  let flight = Promise.resolve();
  const ready = readFile(options.filename, 'utf8').then(text => { preferences = parseIMessagePreferences(JSON.parse(text)); })
    .catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lastStatus = 'Could not load notification settings. Notifications are off.'; });
  const snapshot = (): IMessageSettings => ({ ...preferences, available, lastStatus });
  const publish = () => { for (const listener of listeners) listener(snapshot()); };
  const serialize = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = flight.then(run); flight = next.then(() => {}, () => {}); return next;
  };
  const submit = async (text: string, kind?: NotificationKind) => {
    currentKind = kind;
    current = new AbortController();
    try {
      await (options.send ?? sendIMessage)(preferences.recipient, text, current.signal);
      lastStatus = 'Submitted to Messages. Delivery to your device is not confirmed.';
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : 'Could not submit the notification.';
    } finally { current = null; currentKind = undefined; publish(); }
  };
  const assertAvailable = () => {
    if (closed || !available) throw new Error('iMessage notifications are available on macOS only.');
  };
  return {
    async reply(recipient: string, text: string) {
      assertAvailable();
      const atRevision = revision;
      return serialize(async () => {
        await ready;
        if (closed || revision !== atRevision || preferences.recipient.toLowerCase() !== recipient.toLowerCase()) return;
        await submit(text);
      });
    },
    async get() { await ready; return snapshot(); },
    subscribe(listener: (state: IMessageSettings) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async save(value: unknown) {
      assertAvailable();
      const next = parseIMessagePreferences(value);
      revision++; current?.abort();
      return serialize(async () => {
        await ready;
        await mkdir(path.dirname(options.filename), { recursive: true });
        const temporary = `${options.filename}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
        await rename(temporary, options.filename);
        preferences = next; lastStatus = 'Settings saved.'; publish(); return snapshot();
      });
    },
    async test() {
      assertAvailable();
      if (pending) throw new Error('A notification is already pending. Try again shortly.');
      pending++;
      try {
        return await serialize(async () => {
          await ready; assertAvailable(); parseIMessageRecipient(preferences.recipient);
          await submit('Cheshi: iMessage notification connection test.'); return snapshot();
        });
      } finally { pending--; }
    },
    notify(event: ChatNotification) {
      if (closed || !available || pending >= 64 || !allows(event.kind)) return;
      const atRevision = revision;
      const atVersion = versions[event.kind];
      pending++;
      void serialize(async () => {
        await ready;
        if (closed || revision !== atRevision || versions[event.kind] !== atVersion || !preferences.enabled || !allows(event.kind)) return;
        const description = { completed: 'Work and the message queue are complete.', attention: 'An approval or question needs your response. Check Cheshi.', failed: 'Work failed. Check Cheshi.' }[event.kind];
        const clean = (text: string) => text.replace(/[\r\n\0]/g, ' ').slice(0, 120);
        await submit(`Cheshi · ${clean(event.workspace)}\n${clean(event.conversation)}\n${description}`, event.kind);
      }).finally(() => { pending--; }).catch(() => { lastStatus = 'Could not process the notification.'; publish(); });
    },
    async dispose() { closed = true; revision++; unsubscribe?.(); current?.abort(); await flight; listeners.clear(); },
  };
}
