import { expect, test } from 'bun:test';
import { runAppleNotesScript } from '../lib/apple-notes-process.mts';
import { appleNotesScript } from '../lib/apple-notes-script.mts';

test.skipIf(process.platform !== 'darwin')('native JXA returns creation time when modification time is missing', async () => {
  const stub = String.raw`function fakeNotesApplication() {
    var target = { id: function () { return 'chosen'; }, name: function () { return 'Title'; },
      exists: function () { return true; }, passwordProtected: function () { return false; },
      modificationDate: function () { return null; },
      creationDate: function () { return new Date('2026-09-15T00:00:00Z'); },
      plaintext: function () { return 'Title'; } };
    return { notes: { byId: function () { return target; } } };
  }`;
  const program = appleNotesScript({ action: 'read', noteId: 'chosen' })
    .replace("Application('com.apple.Notes')", "fakeNotesApplication('com.apple.Notes')");
  expect(program).not.toMatch(/\bApplication\s*\(/);
  expect(JSON.parse(await runAppleNotesScript(`${stub}\n${program}`))).toMatchObject({ ok: true,
    value: { id: 'chosen', modifiedAt: '', createdAt: '2026-09-15T00:00:00.000Z' } });
});

test.skipIf(process.platform !== 'darwin')('native JXA replaces a fake note body and returns the saved version', async () => {
  const stub = String.raw`function fakeNotesApplication() {
    var html = '<h1>Title</h1><p>Old</p>';
    var target = { id: function () { return 'chosen'; }, name: function () { return 'Title'; },
      exists: function () { return true; }, passwordProtected: function () { return false; },
      modificationDate: function () { return new Date('2026-09-16T00:00:00Z'); },
      plaintext: function () { return 'Title\nNew'; }, attachments: function () { return []; } };
    Object.defineProperty(target, 'body', { get: function () { return function () { return html; }; },
      set: function (value) { html = value; } });
    return { notes: { byId: function (id) { if (id !== 'chosen') throw Error('Unexpected target'); return target; } } };
  }`;
  const program = appleNotesScript({ action: 'update', noteId: 'chosen', title: 'Title', html: '<p>New</p>',
    expectedHtml: '<h1>Title</h1><p>Old</p>', expectedModifiedAt: '2026-09-16T00:00:00.000Z', expectedTitle: 'Title' })
    .replace("Application('com.apple.Notes')", "fakeNotesApplication('com.apple.Notes')");
  expect(program).not.toMatch(/\bApplication\s*\(/);
  expect(JSON.parse(await runAppleNotesScript(`${stub}\n${program}`))).toMatchObject({ ok: true,
    value: { id: 'chosen', html: '<h1>Title</h1><p>New</p>', attachmentCount: 0 } });
});

async function expectProcessFailure(operation: Promise<string>, reason: string) {
  try { await operation; }
  catch (error) { expect(error).toMatchObject({ reason }); return; }
  throw new Error('Expected automation to fail.');
}

test.skipIf(process.platform !== 'darwin')('runs stdin through native JXA with a fake target and no access to personal Notes', async () => {
  // JXA reserves Application and does not allow it to be shadowed. Replace its
  // one call site with a differently named fake before invoking the interpreter.
  const stub = String.raw`function fakeNotesApplication(id) {
    if (id !== 'com.apple.Notes') throw new Error('Unexpected application');
    return { accounts: function () { return []; } };
  }`;
  const program = appleNotesScript({ action: 'folders' }).replace("Application('com.apple.Notes')", "fakeNotesApplication('com.apple.Notes')");
  expect(program).not.toMatch(/\bApplication\s*\(/);
  const script = `${stub}\n${program}`;
  expect(JSON.parse(await runAppleNotesScript(script))).toEqual({ ok: true, value: [] });
});

test.skipIf(process.platform !== 'darwin')('limits native automation execution time and output size', async () => {
  await expectProcessFailure(runAppleNotesScript('while (true) {}', { timeoutMs: 150 }), 'timeout');
  await expectProcessFailure(runAppleNotesScript('"x".repeat(10000);', { maxOutputBytes: 100 }), 'output');
});

test.skipIf(process.platform !== 'darwin')('native JXA deletion targets a fake note without contacting Apple Notes', async () => {
  const stub = String.raw`function fakeNotesApplication(id) {
    if (id !== 'com.apple.Notes') throw new Error('Unexpected application');
    var target = { id: function () { return 'chosen'; }, name: function () { return 'Test'; },
      exists: function () { return true; }, passwordProtected: function () { return false; },
      modificationDate: function () { return new Date('2026-09-16T00:00:00Z'); } };
    return { notes: { byId: function (noteId) {
      if (noteId !== 'chosen') throw new Error('Unexpected note');
      return target;
    } }, delete: function (note) { if (note !== target) throw new Error('Unexpected deletion target'); } };
  }`;
  const program = appleNotesScript({ action: 'delete', noteId: 'chosen' }).replace("Application('com.apple.Notes')", "fakeNotesApplication('com.apple.Notes')");
  expect(program).not.toMatch(/\bApplication\s*\(/);
  expect(JSON.parse(await runAppleNotesScript(`${stub}\n${program}`))).toEqual({ ok: true, value: { id: 'chosen' } });
});
