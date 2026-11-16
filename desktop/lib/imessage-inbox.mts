import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

export interface InboxMessage { rowid: number; guid: string; text: string | null; }
export interface IMessageInbox {
  latest(): number;
  read(after: number, sender: string): { cursor: number; messages: InboxMessage[] };
  close(): void;
}
/** Open the live WAL database read-only. Never copy it, checkpoint it, or change its journal mode. */
export function openIMessageInbox(filename = path.join(homedir(), 'Library/Messages/chat.db')): IMessageInbox {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(filename, { readOnly: true });
  let floor: number | undefined;
  try {
    const latest = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS id FROM message');
    // Limit eligible messages to direct, incoming iMessages from the saved address.
    // Advance across other rows without retrieving their sender or message body.
    const batch = db.prepare('SELECT ROWID AS id FROM message WHERE ROWID > ? ORDER BY ROWID LIMIT 100');
    const incoming = db.prepare(`SELECT m.ROWID AS rowid, m.guid, m.text FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ? AND m.ROWID <= ? AND lower(h.id) = lower(?)
        AND m.service = 'iMessage' AND m.is_from_me = 0 AND m.is_finished = 1
        AND m.item_type = 0 AND m.associated_message_type = 0
        AND m.is_system_message = 0 AND m.is_service_message = 0
        AND m.date_retracted = 0 AND m.date_edited = 0
        AND EXISTS (SELECT 1 FROM chat_message_join cm JOIN chat c ON c.ROWID = cm.chat_id
          WHERE cm.message_id = m.ROWID AND c.service_name = 'iMessage'
            AND c.style = 45
            AND (SELECT COUNT(*) FROM chat_handle_join ch WHERE ch.chat_id = c.ROWID) = 1)`);
    return {
      latest: () => Number(latest.get()!.id),
      read(after, sender) {
        floor ??= after;
        const rows = batch.all(after);
        const cursor = rows.length ? Number(rows.at(-1)!.id) : after;
        // Messages may finish syncing after their row is inserted. Revisit a bounded tail;
        // the controller deduplicates GUIDs, and the arming floor excludes historical rows.
        const messages = incoming.all(Math.max(floor, after - 100), cursor, sender).map(row => ({ rowid: Number(row.rowid),
          guid: String(row.guid), text: typeof row.text === 'string' ? row.text : null }));
        return { cursor, messages };
      },
      close: () => db.close(),
    };
  } catch (error) { db.close(); throw error; }
}
