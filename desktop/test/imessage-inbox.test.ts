import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openIMessageInbox } from '../lib/imessage-inbox.mts';

test('live WAL reads exclude outgoing, group, edited, non-iMessage and foreign-sender records', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-inbox-'));
  const filename = path.join(directory, 'chat.db');
  const db = new DatabaseSync(filename);
  let reader: ReturnType<typeof openIMessageInbox> | undefined;
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE message (guid TEXT, text TEXT, handle_id INTEGER DEFAULT 1, service TEXT DEFAULT 'iMessage',
        is_from_me INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 1, item_type INTEGER DEFAULT 0,
        associated_message_type INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
        is_service_message INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0);
      CREATE TABLE handle (id TEXT); INSERT INTO handle VALUES ('me@example.com'), ('other@example.com');
      CREATE TABLE chat (service_name TEXT, group_id TEXT, style INTEGER); INSERT INTO chat VALUES ('iMessage', 'direct-chat-id',45), ('iMessage', 'group',43);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER); INSERT INTO chat_handle_join VALUES (1,1),(2,1),(2,2);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);`);
    reader = openIMessageInbox(filename); assert.equal(reader.latest(), 0);
    const insert = db.prepare('INSERT INTO message (guid, text, is_from_me, handle_id, service, date_edited) VALUES (?,?,?,?,?,?)');
    for (const [index, fromMe, handle, service, edited, chat] of [
      [1,0,1,'iMessage',0,1], [2,1,1,'iMessage',0,1], [3,0,2,'iMessage',0,1],
      [4,0,1,'SMS',0,1], [5,0,1,'iMessage',1,1], [6,0,1,'iMessage',0,2],
    ] as const) {
      const result = insert.run(`guid-${index}`, '체시 상태', fromMe, handle, service, edited);
      db.prepare('INSERT INTO chat_message_join VALUES (?,?)').run(chat, result.lastInsertRowid);
    }
    const result = reader.read(0, 'ME@example.com');
    assert.equal(result.cursor, 6); assert.deepEqual(result.messages, [{ rowid: 1, guid: 'guid-1', text: '체시 상태' }]);
    assert.equal(reader.read(result.cursor, 'me@example.com').messages.length, 1);
    const pending = insert.run('late-sync', null, 0, 1, 'iMessage', 0);
    db.prepare('UPDATE message SET is_finished = 0 WHERE ROWID = ?').run(pending.lastInsertRowid);
    db.prepare('INSERT INTO chat_message_join VALUES (1,?)').run(pending.lastInsertRowid);
    const incomplete = reader.read(result.cursor, 'me@example.com');
    assert.equal(incomplete.messages.some(row => row.guid === 'late-sync'), false);
    db.prepare('UPDATE message SET is_finished = 1, text = ? WHERE ROWID = ?').run('체시 상태', pending.lastInsertRowid);
    assert.equal(reader.read(incomplete.cursor, 'me@example.com').messages.some(row => row.guid === 'late-sync'), true);
    const armed = openIMessageInbox(filename);
    try { assert.deepEqual(armed.read(armed.latest(), 'me@example.com').messages, []); }
    finally { armed.close(); }
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  } finally { reader?.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
