import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createChatAttachmentImageReader, registerChatAttachmentImageIpc } from '../lib/chat-attachment-image.mts';

test('image reads reject malformed paths and skip non-image files before decoding', () => {
  let decoded = false;
  const read = createChatAttachmentImageReader({ createFromPath: (_path: string) => {
    decoded = true;
    throw new Error('Unexpected image read');
  } });
  for (const value of [null, 42, '', 'relative.png', '/tmp/bad\0.png']) {
    throws(() => read(value), TypeError);
  }
  strictEqual(read('/tmp/notes.txt'), null);
  strictEqual(read('/tmp/image.svg'), null);
  strictEqual(decoded, false);
});

test('both image IPC routes validate the sender before reading and choose the correct resolution', () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const calls: [unknown, boolean | undefined][] = [];
  let permitted = false;
  registerChatAttachmentImageIpc({
    ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    assertSender: () => { if (!permitted) throw new Error('Unauthorized sender'); },
    readImage: (path, thumbnail) => { calls.push([path, thumbnail]); return 'image'; },
  });
  const event = {} as IpcMainInvokeEvent;
  for (const handler of handlers.values()) throws(() => handler(event, '/tmp/photo.png'), /Unauthorized/);
  deepStrictEqual(calls, []);
  permitted = true;
  for (const handler of handlers.values()) strictEqual(handler(event, '/tmp/photo.png'), 'image');
  deepStrictEqual(calls, [['/tmp/photo.png', true], ['/tmp/photo.png', false]]);
});
