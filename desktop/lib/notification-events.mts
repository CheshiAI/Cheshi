import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_NOTIFICATION_EVENTS, NOTIFICATION_KINDS, parseNotificationEvents,
  type NotificationEventSettings, type NotificationKind } from '../shared/notification-events.ts';

function legacyEvents(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid legacy notification settings.');
  return NOTIFICATION_KINDS.some(kind => kind in value) ? parseNotificationEvents(value) : { ...DEFAULT_NOTIFICATION_EVENTS };
}

/** One event policy per Mac, independent of delivery credentials and connections. */
export function createNotificationEvents(options: { filename: string; legacyIMessageFilename: string }) {
  let preferences = { ...DEFAULT_NOTIFICATION_EVENTS };
  let error: string | null = null;
  const listeners = new Set<(value: NotificationEventSettings) => void>();
  const write = (value: typeof preferences) => {
    mkdirSync(path.dirname(options.filename), { recursive: true, mode: 0o700 });
    const temporary = `${options.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, options.filename);
    } finally { rmSync(temporary, { force: true }); }
  };
  try { preferences = parseNotificationEvents(JSON.parse(readFileSync(options.filename, 'utf8'))); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        let legacy: unknown;
        try { legacy = JSON.parse(readFileSync(options.legacyIMessageFilename, 'utf8')); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
        if (legacy !== undefined) preferences = legacyEvents(legacy);
        write(preferences);
      } catch { error = 'Could not migrate notification events. Existing settings were preserved.'; }
    } else error = 'Could not load notification events. Existing settings were preserved.';
  }
  const snapshot = (): NotificationEventSettings => ({ ...preferences, error });
  const assertWritable = () => { if (error) throw new Error(error); };
  return {
    get: snapshot,
    allows: (kind: NotificationKind) => error === null && preferences[kind] === true,
    subscribe(listener: (value: NotificationEventSettings) => void) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    set(kind: unknown, enabled: unknown) {
      assertWritable();
      if (!NOTIFICATION_KINDS.includes(kind as NotificationKind) || typeof enabled !== 'boolean') throw new TypeError('Invalid notification switch.');
      const next = parseNotificationEvents({ ...preferences, [String(kind)]: enabled });
      write(next); preferences = next;
      for (const listener of listeners) listener(snapshot());
      return snapshot();
    },
  };
}
