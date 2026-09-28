import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { Editor } from '@tiptap/core';
import { AppleNotesService } from '../lib/apple-notes-service.mts';
import { createAppleNotesApi } from '../lib/apple-notes-preload.cts';
import { noteDocumentReadOnlyReason } from '../shared/apple-notes-document';
import { noteEditorHtml, noteEditorTitle } from '../frontend/src/features/notes/appleNotesEditorContent';
import { noteEditorExtensions } from '../frontend/src/features/notes/appleNotesEditorExtensions';
import { createNoteDraft } from '../frontend/src/features/notes/appleNotesDraft';
import { appleNotesTextExport } from '../frontend/src/features/notes/appleNotesTextExport';
import { appleNoteCreateInput, APPLE_NOTES_MAX_TITLE_LENGTH } from '../shared/apple-notes';

test('body-only exports preserve leading blank lines, long first lines, Unicode and literal markup', async () => {
  const window = new Window();
  const examples: [string, string][] = [
    ['First line\n\n  Body\t😀\n', 'First line'],
    ['\n\nBody\n', 'Untitled note'],
    ['  \nBody', 'Untitled note'],
    ['한글'.repeat(150) + '\nBody', '한글'.repeat(150).slice(0, APPLE_NOTES_MAX_TITLE_LENGTH)],
    ['  First line  \r\nSecond\rThird', 'First line'],
    ['</code></pre><script>bad()</script> &amp; "quotes"\n## Markdown', '</code></pre><script>bad()</script> &amp; "quotes"'],
  ];
  try {
    for (const [body, title] of examples) {
      const exported = appleNotesTextExport(body);
      const request = appleNoteCreateInput({ folderId: 'folder', ...exported });
      expect(request.title).toBe(title);
      expect(request.body).toBe(body);
      expect(request.htmlIncludesTitle).toBe(true);
      const parsed = new window.DOMParser().parseFromString(request.html!, 'text/html');
      expect(parsed.body.children.length).toBe(1);
      expect(parsed.querySelector('h1,script')).toBeNull();
      expect(parsed.querySelector('pre code')?.textContent.replace(/\r\n?/g, '\n')).toBe(body.replace(/\r\n?/g, '\n'));
    }
  } finally { await window.happyDOM.close(); }
});

// Native markup observed after Notes imports Cheshi's <h1> + <pre> export.
// Fixtures stand in for Notes' HTML conversion, not for the service/editor.
function nativeReply(suffix = '', legacyTitle = true) {
  return (legacyTitle ? '<div><b><span style="font-size: 24px">Saved &amp; title</span></b></div>\n' : '')
    + '<div><font face="Courier"><tt>  한글 &lt;text&gt; &amp; 😀</tt></font></div>\n'
    + '<div><font face="Courier"><tt><br></tt></font></div>\n'
    + `<div><font face="Courier"><tt>Last\tline${suffix}</tt></font></div>\n`;
}

test.each([true, false])('chat text crosses create, read, edit and reopen twice without loss (legacy title: %s)', async legacyTitle => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, DOMParser: window.DOMParser,
    Node: window.Node, HTMLElement: window.HTMLElement, Element: window.Element, MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let editor: Editor | undefined;
  let creates = 0;
  let writes = 0;
  let html = '';
  const body = '  한글 <text> & 😀\n\nLast\tline';
  const title = legacyTitle ? 'Saved & title' : appleNotesTextExport(body).title;
  const bodyBlock = legacyTitle ? 1 : 0;
  const folder = { exists: () => true };
  const nativeNote = {
    exists: () => creates > 0, id: () => 'saved-note', name: () => title,
    passwordProtected: () => false, attachments: () => [],
    modificationDate: () => new Date(Date.UTC(2026, 8, 29, 0, 0, writes)),
    creationDate: () => new Date('2026-09-29T00:00:00.000Z'),
    plaintext: () => (legacyTitle ? title + '\n' : '') + body + ' edited'.repeat(writes),
  };
  Object.defineProperty(nativeNote, 'body', {
    get: () => () => html,
    set: (value: string) => {
      const saved = new window.DOMParser().parseFromString(value, 'text/html');
      expect(saved.querySelector('h1')?.textContent).toBe(legacyTitle ? title : undefined);
      expect(saved.querySelector('pre code')?.textContent).toBe(body + ' edited'.repeat(writes + 1));
      writes += 1;
      html = nativeReply(' edited'.repeat(writes), legacyTitle);
    },
  });
  const service = new AppleNotesService({ platform: 'darwin', execute: async source =>
    vm.runInNewContext(source, { Application: () => ({
      folders: { byId: (id: string) => { expect(id).toBe('folder'); return folder; } },
      notes: { byId: (id: string) => { expect(id).toBe('saved-note'); return nativeNote; } },
      make: (input: { new: string; at: typeof folder; withProperties: { body: string } }) => {
        expect(input.new).toBe('note');
        expect(input.at).toBe(folder);
        expect(input.withProperties.body).toBe(legacyTitle
          ? '<h1>Saved &amp; title</h1><pre>  한글 &lt;text&gt; &amp; 😀\n\nLast\tline</pre>'
          : '<pre><code>  한글 &lt;text&gt; &amp; 😀\n\nLast\tline</code></pre>');
        creates += 1;
        html = nativeReply('', legacyTitle);
        return nativeNote;
      },
    }) }) as string });
  const api = createAppleNotesApi({ invoke: async (channel: string, request: unknown) => {
    if (channel === 'cheshi:apple-notes-create') return service.create(request);
    if (channel === 'cheshi:apple-notes-document') return service.document(request);
    if (channel === 'cheshi:apple-notes-update') return service.update(request);
    throw new Error(`Unexpected channel: ${channel}`);
  } }, 'darwin');
  try {
    const created = await api.create({ folderId: 'folder', ...(legacyTitle ? { title, body } : appleNotesTextExport(body)) });
    if (!created.ok) throw new Error('Expected creation to succeed.');
    const document = await api.document(created.value.id);
    expect(noteDocumentReadOnlyReason(document)).toBeNull();
    editor = new Editor({ extensions: noteEditorExtensions(), content: noteEditorHtml(document),
      parseOptions: { preserveWhitespace: 'full' } });
    const draft = createNoteDraft(document, editor.getHTML());
    expect(editor.state.doc.child(bodyBlock).textContent).toBe(body);
    for (let edit = 1; edit <= 2; edit++) {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' edited');
      draft.edit(noteEditorTitle(editor.state.doc), editor.getHTML());
      const before = editor.getJSON();
      const saved = await draft.save(api);
      if (!saved) throw new Error('Expected an editable saved document.');
      expect(noteDocumentReadOnlyReason(saved)).toBeNull();
      expect(draft.getSnapshot()).toMatchObject({ dirty: false, blocked: false });
      const reopened = await api.document(saved.id);
      expect(reopened.html).toBe(nativeReply(' edited'.repeat(edit), legacyTitle));
      editor.commands.setContent(noteEditorHtml(reopened), { parseOptions: { preserveWhitespace: 'full' } });
      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.doc.child(bodyBlock).textContent).toBe(body + ' edited'.repeat(edit));
    }
    expect(creates).toBe(1);
    expect(writes).toBe(2);
  } finally {
    editor?.destroy();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
