import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { AppleNotesService } from '../lib/apple-notes-service.mts';
import { createAppleNotesApi } from '../lib/apple-notes-preload.cts';
import { appleNoteUpdateInput, isEditableNoteHtml, type AppleNoteDocument, type AppleNoteUpdateInput } from '../shared/apple-notes-document.ts';
import { createNewNoteDraft, getNewNoteDraft, startNewNoteDraft, releaseNewNoteDraft } from '../frontend/src/features/notes/appleNotesNewDraft';
import { createNoteDraft } from '../frontend/src/features/notes/appleNotesDraft';
import { appleNoteSummary, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, type AppleNoteCreateInput, type AppleNotesApi, type AppleNotesReply } from '../shared/apple-notes.ts';

const original: AppleNoteDocument = { id: 'chosen', title: 'Title', html: '<h1>Title</h1><div>Original</div>',
  plaintext: 'Title\nOriginal', modifiedAt: '2026-09-16T00:00:00.000Z', locked: false, attachmentCount: 0 };
const input = (): AppleNoteUpdateInput => ({ noteId: original.id, title: 'Changed', html: '<p><strong>New</strong> content</p>',
  expectedTitle: original.title, expectedHtml: original.html, expectedModifiedAt: original.modifiedAt });

function fixture(modifiedAt = original.modifiedAt) {
  let html = original.html;
  let title = original.title;
  let time = modifiedAt;
  let attachments = 0;
  let locked = false;
  let writes = 0;
  let executions = 0;
  const note = { exists: () => true, id: () => original.id, name: () => title, modificationDate: () => time ? new Date(time) : null,
    creationDate: () => new Date('2026-09-15T00:00:00.000Z'),
    passwordProtected: () => locked, plaintext: () => html.replace(/<[^>]+>/g, ''), attachments: () => Array(attachments) };
  Object.defineProperty(note, 'body', { get: () => () => html, set: (value: string) => {
    writes += 1; html = value; time = '2026-09-16T00:00:01.000Z'; title = 'Changed';
  } });
  const service = new AppleNotesService({ platform: 'darwin', execute: async source => {
    executions += 1;
    return vm.runInNewContext(source, { Application: () => ({ notes: { byId: (id: string) => {
      expect(id).toBe('chosen'); return note;
    } } }) }) as string;
  } });
  return { service, externalEdit: () => { html = '<p>External edit</p>'; }, attach: () => { attachments = 1; }, lock: () => { locked = true; },
    get writes() { return writes; }, get html() { return html; }, get executions() { return executions; } };
}

test('updates the exact note, returns the saved document, and invalidates the cached body', async () => {
  const f = fixture();
  await f.service.read('chosen');
  const before = await f.service.document('chosen');
  expect(before).toMatchObject({ ok: true, value: { ...original, plaintext: 'TitleOriginal' } });
  const result = await f.service.update(input());
  expect(result).toMatchObject({ ok: true, value: { id: 'chosen', title: 'Changed', html: '<h1>Changed</h1><p><strong>New</strong> content</p>' } });
  expect(f.writes).toBe(1);
  const read = await f.service.read('chosen');
  expect(read.ok && read.value.title).toBe('Changed');
  expect(f.executions).toBe(4);
});

test('creation date crosses the service and preload when modification time is unavailable, then survives saving', async () => {
  const f = fixture('');
  const api = createAppleNotesApi({ invoke: async (channel: string, ...args: unknown[]) => {
    if (channel === 'cheshi:apple-notes-document') return f.service.document(args[0]);
    if (channel === 'cheshi:apple-notes-update') return f.service.update(args[0]);
    throw new Error(`Unexpected channel: ${channel}`);
  } }, 'darwin');
  const document = await api.document('chosen');
  expect(document).toMatchObject({ modifiedAt: '', createdAt: '2026-09-15T00:00:00.000Z' });
  const draft = createNoteDraft(document, '<p>Original</p>');
  draft.edit('Changed', '<p>New</p>');
  const saved = await draft.save(api);
  if (!saved) throw new Error('Expected a saved document.');
  expect(saved).toMatchObject({ modifiedAt: '2026-09-16T00:00:01.000Z', createdAt: '2026-09-15T00:00:00.000Z' });
  expect(draft.getSnapshot().original).toBe(saved);
  expect(f.writes).toBe(1);

  const conflicted = fixture('');
  conflicted.externalEdit();
  expect(await conflicted.service.update({ ...input(), expectedModifiedAt: '' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(conflicted.writes).toBe(0);
});

test('timestamp boundaries reject malformed values while preserving unavailable modification dates', () => {
  expect(appleNoteSummary({ ...original, modifiedAt: '', createdAt: original.modifiedAt }))
    .toMatchObject({ modifiedAt: '', createdAt: original.modifiedAt });
  for (const value of [null, false, 0, 'invalid', ' ']) {
    expect(() => appleNoteSummary({ ...original, modifiedAt: value })).toThrow();
    expect(() => appleNoteSummary({ ...original, createdAt: value })).toThrow();
    expect(() => appleNoteUpdateInput({ ...input(), expectedModifiedAt: value })).toThrow();
  }
});

test('saves font-size spans and permits another edit of the returned Apple Notes document', async () => {
  const f = fixture();
  const html = '<p><strong><span style="font-size: 24px">Large text</span></strong></p>';
  const saved = await f.service.update({ ...input(), html });
  if (!saved.ok) throw new Error('Expected font-size update to succeed.');
  expect(saved.value.html).toContain(html);
  const again = await f.service.update({ ...input(), html: html + '<p>Second edit</p>',
    expectedHtml: saved.value.html, expectedTitle: saved.value.title, expectedModifiedAt: saved.value.modifiedAt });
  expect(again.ok).toBe(true);
  expect(f.writes).toBe(2);
});

test('font-size support does not admit other styles or invalid size values', () => {
  for (const style of ['font-size: 24px', ' font-size : 13.5px; ', 'FONT-SIZE: 24PX']) {
    expect(isEditableNoteHtml(`<span style="${style}">Text</span>`)).toBe(true);
  }
  for (const style of ['font-size: 0px', 'font-size: -1px', 'font-size: 24px; color: red',
    'font-size: expression(alert(1))', 'font-size: url(https://example.com)', 'font-size: 24px !important']) {
    const html = `<span style="${style}">Text</span>`;
    expect(isEditableNoteHtml(html)).toBe(false);
    expect(() => appleNoteUpdateInput({ ...input(), html })).toThrow();
  }
});

test('fresh editing reads bypass cache and changes to HTML conflict even with the same timestamp', async () => {
  const f = fixture();
  await f.service.document('chosen');
  f.externalEdit();
  expect(await f.service.document('chosen')).toMatchObject({ ok: true, value: { html: '<p>External edit</p>' } });
  expect(await f.service.update(input())).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(f.writes).toBe(0);
  expect(f.html).toBe('<p>External edit</p>');
});

test('checks attachments and locks at save time and never overwrites unsupported original formatting', async () => {
  const attached = fixture(); attached.attach();
  expect(await attached.service.update(input())).toMatchObject({ ok: false, error: { code: 'read-only' } });
  const locked = fixture(); locked.lock();
  expect(await locked.service.update(input())).toMatchObject({ ok: false, error: { code: 'locked' } });
  const unsupported = fixture();
  expect(await unsupported.service.update({ ...input(), expectedHtml: '<table><tr><td>Value</td></tr></table>' }))
    .toMatchObject({ ok: false, error: { code: 'read-only' } });
  expect(attached.writes + locked.writes + unsupported.writes).toBe(0);
  expect(unsupported.executions).toBe(0);
});

test('serializes overlapping saves to the same note so only one expected version succeeds', async () => {
  const f = fixture();
  const results = await Promise.all([f.service.update(input()), f.service.update(input())]);
  expect(results[0]?.ok).toBe(true);
  expect(results[1]).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(f.writes).toBe(1);
});

test('rejects unsafe or unsupported HTML at the boundary and accepts supported editor markup', () => {
  for (const html of ['<script>alert(1)</script>', '<img src="https://example.com/a">', '<p onclick="evil()">x</p>',
    '<a href="javascript:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>', '<iframe></iframe>',
    '<p style="color:red">x</p>', '<ul data-checked="true"><li>x</li></ul>', '<p><b>x</p>', '<p/><script>', '<!-- comment -->']) {
    expect(isEditableNoteHtml(html)).toBe(false);
    expect(() => appleNoteUpdateInput({ ...input(), html })).toThrow();
  }
  expect(isEditableNoteHtml('<div><h1>Title</h1></div><div><b>A</b><br></div><ol start="2"><li>B</li></ol>')).toBe(true);
  expect(isEditableNoteHtml('<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com?a=1&amp;b=2">Link</a></p>')).toBe(true);
  expect(isEditableNoteHtml('<pre><code class="language-ts">const n = 1 &lt; 2</code></pre>')).toBe(true);
});

test('preload validates update acknowledgements and never retries an uncertain write', async () => {
  for (const value of [{ ok: true, value: { ...original, id: 'wrong' } }, {}, { ok: 'true' }]) {
    let calls = 0;
    const api = createAppleNotesApi({ invoke: async () => { calls += 1; return value; } }, 'darwin');
    expect(await api.update(input())).toMatchObject({ ok: false, error: { code: 'update-unknown' } });
    expect(calls).toBe(1);
  }
});

test('draft keeps edits on conflict and accepts an explicitly reviewed new base before retrying', async () => {
  const draft = createNoteDraft(original, '<p>Original</p>');
  draft.edit('Changed', '<p>My draft</p>');
  let calls = 0;
  await draft.save({ update: async () => { calls += 1; return { ok: false, error: { code: 'conflict', message: 'Conflict' } }; } });
  expect(draft.getSnapshot()).toMatchObject({ dirty: true, blocked: true, title: 'Changed', html: '<p>My draft</p>' });
  await draft.save({ update: async () => { throw new Error('Must not retry'); } });
  expect(calls).toBe(1);
  const latest = { ...original, html: '<p>External edit</p>' };
  draft.rebase(latest, '<p>External edit</p>');
  const result = await draft.save({ update: async request => {
    expect(request.expectedHtml).toBe(latest.html);
    expect(request.html).toBe('<p>My draft</p>');
    return { ok: true, value: { ...latest, title: 'Changed', html: '<h1>Changed</h1><p>My draft</p>' } };
  } });
  expect(result?.title).toBe('Changed');
  expect(draft.getSnapshot()).toMatchObject({ dirty: false, saving: false, saved: true });
});

test('draft deduplicates saves, preserves edits on lost replies, and refuses malformed acknowledgements', async () => {
  const draft = createNoteDraft(original, '<p>Original</p>');
  draft.edit('Changed', '<p>Draft</p>');
  let resolve!: (value: AppleNotesReply<AppleNoteDocument>) => void;
  const promise = new Promise<AppleNotesReply<AppleNoteDocument>>(done => { resolve = done; });
  const operation = draft.save({ update: () => promise });
  expect(await draft.save({ update: () => { throw new Error('Duplicate'); } })).toBeNull();
  draft.edit('Lost edit', '<p>Must not change while saving</p>');
  expect(draft.getSnapshot().title).toBe('Changed');
  resolve({ ok: true, value: { ...original, id: 'wrong' } });
  expect(await operation).toBeNull();
  expect(draft.getSnapshot()).toMatchObject({ dirty: true, blocked: true, html: '<p>Draft</p>', saving: false });
});

const newFolder = { id: 'folder', name: 'Notes', path: 'Notes', account: 'iCloud', isDefault: true };
const newDocument = { ...original, id: 'created', title: 'New', createdAt: original.modifiedAt };

test('new drafts send one rich create request, preserve failed input and retry only after known failures', async () => {
  const calls: AppleNoteCreateInput[] = [];
  let resolve!: (reply: AppleNotesReply<{ id: string; title: string }>) => void;
  const pending = new Promise<AppleNotesReply<{ id: string; title: string }>>(complete => { resolve = complete; });
  const api: Pick<AppleNotesApi, 'create' | 'document'> = {
    create: async request => { calls.push(request); return calls.length === 1
      ? { ok: false, error: { code: 'permission', message: 'Allow Notes automation.' } } : pending; },
    document: async id => { expect(id).toBe('created'); return newDocument; },
  };
  const draft = createNewNoteDraft(newFolder);
  expect(await draft.save(api)).toBeNull();
  expect(calls).toHaveLength(0);
  const html = '<p>New</p><h2>Heading</h2><p><strong>Bold</strong><br>Next line</p><p></p>';
  draft.edit('  New  ', html);
  expect(await draft.save(api)).toBeNull();
  expect(draft.getSnapshot()).toMatchObject({ title: '  New  ', html, dirty: true, blocked: false, error: 'Allow Notes automation.' });
  const saved = draft.save(api);
  expect(await draft.save(api)).toBeNull();
  draft.edit('Ignored while saving', '<p></p>');
  expect(calls).toEqual(Array.from({ length: 2 }, () => ({ folderId: 'folder', title: 'New', body: '', html, htmlIncludesTitle: true })));
  resolve({ ok: true, value: { id: 'created', title: 'New' } });
  expect(await saved).toBe(newDocument);
  expect(await draft.save(api)).toBe(newDocument);
  expect(calls).toHaveLength(2);
  expect(draft.getSnapshot()).toMatchObject({ saved: true, dirty: false, saving: false });
});

test('lost create responses block retry while acknowledged creates retry only document loading', async () => {
  for (const lost of [true, false]) {
    let creates = 0;
    let reads = 0;
    const draft = createNewNoteDraft(newFolder);
    draft.edit('New', '<p>Text</p>');
    const api: Pick<AppleNotesApi, 'create' | 'document'> = {
      create: async () => { creates += 1; if (lost) throw new Error('IPC disconnected'); return { ok: true, value: { id: 'created', title: 'New' } }; },
      document: async () => { reads += 1; if (reads === 1) throw new Error('Read unavailable'); return newDocument; },
    };
    expect(await draft.save(api)).toBeNull();
    expect(draft.getSnapshot().dirty).toBe(true);
    if (lost) {
      expect(draft.getSnapshot()).toMatchObject({ blocked: true, error: APPLE_NOTES_SAVE_UNKNOWN_MESSAGE });
      expect(await draft.save(api)).toBeNull();
      expect(reads).toBe(0);
    } else {
      expect(draft.getSnapshot()).toMatchObject({ createdId: 'created', blocked: false });
      draft.edit('Must not diverge from created note', '<p>Changed</p>');
      expect(draft.getSnapshot().title).toBe('New');
      expect(await draft.save(api)).toBe(newDocument);
      expect(reads).toBe(2);
    }
    expect(creates).toBe(1);
  }
});

test('new drafts survive remounts in memory and are released only when idle', async () => {
  const draft = startNewNoteDraft(newFolder);
  draft.edit('New', '<p>Text</p>');
  expect(getNewNoteDraft()).toBe(draft);
  expect(startNewNoteDraft({ ...newFolder, id: 'other' })).toBe(draft);
  let resolve!: (document: AppleNoteDocument) => void;
  const pending = new Promise<AppleNoteDocument>(complete => { resolve = complete; });
  const saving = draft.save({ create: async () => ({ ok: true, value: { id: 'created', title: 'New' } }), document: async () => pending });
  releaseNewNoteDraft(draft);
  expect(getNewNoteDraft()).toBe(draft);
  resolve(newDocument);
  expect(await saving).toBe(newDocument);
  expect(getNewNoteDraft()?.getSnapshot().saved).toBe(true);
  releaseNewNoteDraft(draft);
  expect(getNewNoteDraft()).toBeNull();
  const cancelled = startNewNoteDraft(newFolder);
  releaseNewNoteDraft(cancelled);
  expect(getNewNoteDraft()).toBeNull();
});

test('invalid local rich drafts remain editable and never reach native creation', async () => {
  let creates = 0;
  const draft = createNewNoteDraft(newFolder);
  draft.edit('New', '<p onclick="bad()">Text</p>');
  const api: Pick<AppleNotesApi, 'create' | 'document'> = {
    create: async () => { creates += 1; return { ok: true, value: { id: 'created', title: 'New' } }; },
    document: async () => newDocument,
  };
  expect(await draft.save(api)).toBeNull();
  expect(creates).toBe(0);
  expect(draft.getSnapshot().blocked).toBe(false);
  draft.edit('New', '<p>Fixed</p>');
  expect(await draft.save(api)).toBe(newDocument);
  expect(creates).toBe(1);
});

test('unified drafts send the complete document through preload and update without prepending the title', async () => {
  const f = fixture();
  const api = createAppleNotesApi({ invoke: async (channel, request) => {
    expect(channel).toBe('cheshi:apple-notes-update');
    expect(request.htmlIncludesTitle).toBe(true);
    return f.service.update(request);
  } }, 'darwin');
  const draft = createNoteDraft(original, original.html);
  const html = '<p>Changed</p><p>Second line<br>Soft break</p><p></p><p>Last line</p>';
  draft.edit('Changed', html);
  const saved = await draft.save(api);
  expect(saved?.html).toBe(html);
  expect(f.html).toBe(html);
  expect(f.writes).toBe(1);
  draft.edit('Changed', html + '<p>Another line</p>');
  expect((await draft.save(api))?.html).toBe(html + '<p>Another line</p>');
  expect(f.html.match(/Changed/g)).toHaveLength(1);
  draft.edit('Changed', '<p>Unsaved</p>');
  draft.discard();
  expect(draft.getSnapshot().html).toBe(html + '<p>Another line</p>');
});

test('full-document update mode requires the literal true and preserves the legacy contract otherwise', () => {
  expect(appleNoteUpdateInput({ ...input(), htmlIncludesTitle: true }).htmlIncludesTitle).toBe(true);
  expect(appleNoteUpdateInput({ ...input(), htmlIncludesTitle: false }).htmlIncludesTitle).toBeUndefined();
  for (const value of [null, 'true', 1, {}, []]) {
    expect(() => appleNoteUpdateInput({ ...input(), htmlIncludesTitle: value })).toThrow();
  }
});
