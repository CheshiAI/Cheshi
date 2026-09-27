import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_IMESSAGE_PREFERENCES, parseIMessagePreferences, parseIMessageRecipient,
  type IMessageSettings, type NotificationKind } from '../shared/imessage-notifications.ts';
import { sendIMessage } from './imessage-process.mts';

export interface ChatNotification { kind: NotificationKind; workspace: string; conversation: string; }
export interface NotificationSink { notify(event: ChatNotification): void; }
/** App-wide settings and bounded, serialized delivery; notification failures never fail chat work. */
export function createIMessageNotifications(options: {
  filename: string; platform?: string;
  send?: (recipient: string, text: string, signal: AbortSignal) => Promise<void>;
}) {
  let preferences = { ...DEFAULT_IMESSAGE_PREFERENCES };
  let lastStatus: string | null = null;
  const available = (options.platform ?? process.platform) === 'darwin';
  const listeners = new Set<(state: IMessageSettings) => void>();
  let revision = 0, closed = false, pending = 0;
  let current: AbortController | null = null;
  let flight = Promise.resolve();
  const ready = readFile(options.filename, 'utf8').then(text => { preferences = parseIMessagePreferences(JSON.parse(text)); })
    .catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lastStatus = 'Could not load notification settings. Notifications are off.'; });
  const snapshot = (): IMessageSettings => ({ ...preferences, available, lastStatus });
  const publish = () => { for (const listener of listeners) listener(snapshot()); };
  const serialize = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = flight.then(run); flight = next.then(() => {}, () => {}); return next;
  };
  const submit = async (text: string) => {
    current = new AbortController();
    try {
      await (options.send ?? sendIMessage)(preferences.recipient, text, current.signal);
      lastStatus = 'Submitted to Messages. Delivery to your device is not confirmed.';
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : 'Could not submit the notification.';
    } finally { current = null; publish(); }
  };
  const assertAvailable = () => {
    if (closed || !available) throw new Error('iMessage notifications are available on macOS only.');
  };
  return {
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
      if (closed || !available || pending >= 64) return;
      const atRevision = revision;
      pending++;
      void serialize(async () => {
        await ready;
        if (closed || revision !== atRevision || !preferences.enabled || !preferences[event.kind]) return;
        const description = { completed: '작업과 대기열이 완료되었습니다.', attention: '승인 또는 질문에 사용자 응답이 필요합니다.', failed: '작업이 실패했습니다. 앱에서 확인해 주세요.' }[event.kind];
        const clean = (text: string) => text.replace(/[\r\n\0]/g, ' ').slice(0, 120);
        await submit(`Cheshi · ${clean(event.workspace)}\n${clean(event.conversation)}\n${description}`);
      }).finally(() => { pending--; }).catch(() => { lastStatus = 'Could not process the notification.'; publish(); });
    },
    async dispose() { closed = true; revision++; current?.abort(); await flight; listeners.clear(); },
  };
}
