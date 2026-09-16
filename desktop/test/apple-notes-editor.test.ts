import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../frontend/src/features/notes/appleNotesEditorExtensions';
import { noteEditorHtml } from '../frontend/src/features/notes/appleNotesEditorContent';
import { noteTimestamp } from '../frontend/src/features/notes/appleNotesTimestamp';
import { appleNoteUpdateInput, isEditableNoteHtml, noteDocumentReadOnlyReason, type AppleNoteDocument } from '../shared/apple-notes-document';

const note: AppleNoteDocument = { id: 'test', title: 'Title', html: '<div><h1>Title</h1></div><div>First line</div><div>Second line</div>',
  plaintext: 'Title\nFirst line\nSecond line', modifiedAt: '2026-09-16T00:00:00.000Z', locked: false, attachmentCount: 0 };

test('header timestamp prefers modification time and falls back to creation time', () => {
  const createdAt = '2026-09-15T00:00:00.000Z';
  const modified = noteTimestamp({ ...note, createdAt });
  expect(modified?.dateTime).toBe(note.modifiedAt);
  expect(modified?.label).toStartWith('Updated September');
  const created = noteTimestamp({ modifiedAt: '', createdAt });
  expect(created?.dateTime).toBe(createdAt);
  expect(created?.label).toStartWith('Created September');
  expect(noteTimestamp({ modifiedAt: '' })).toBeNull();
});

function withDom(run: () => void) {
  const window = new Window();
  const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
    DOMParser: window.DOMParser, Node: window.Node, HTMLElement: window.HTMLElement, Element: window.Element,
    MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try { run(); }
  finally {
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('imports Apple Notes paragraph boundaries and separates the title without duplicating it', () => withDom(() => {
  const html = noteEditorHtml(note);
  expect(html).toBe('<p>First line</p><p>Second line</p>');
  const editor = new Editor({ extensions: noteEditorExtensions(), content: html, parseOptions: { preserveWhitespace: 'full' } });
  try {
    expect(editor.getText()).toBe('First line\n\nSecond line');
    const saved = { ...note, html: '<h1>Title</h1>' + editor.getHTML() };
    expect(noteEditorHtml(saved)).toBe(html);
  } finally { editor.destroy(); }
}));

test('Apple Notes font-size spans remain editable and keep body sizes when saved and reopened', () => withDom(() => {
  const original = { ...note, html: '<div><b><span style="font-size: 24px">Title</span></b><br></div>'
    + '<div><br></div><div><b><span style="font-size: 24px">Large text</span></b><br></div>'
    + '<div><span style="font-size: 13.5px;">Small text</span><br></div><div>Plain text<br></div>' };
  expect(noteDocumentReadOnlyReason(original)).toBeNull();
  const imported = noteEditorHtml(original);
  expect(imported).not.toContain('Title');
  const editor = new Editor({ extensions: noteEditorExtensions(), content: imported, parseOptions: { preserveWhitespace: 'full' } });
  try {
    const blocks = editor.getJSON().content!;
    expect<unknown>(blocks[0]).toEqual({ type: 'paragraph' });
    expect(blocks[1]?.content?.[0]?.marks).toContainEqual({ type: 'noteFontSize', attrs: { fontSize: '24px' } });
    expect(blocks[1]?.content?.[0]?.marks).toContainEqual({ type: 'bold' });
    expect(blocks[2]?.content?.[0]?.marks).toContainEqual({ type: 'noteFontSize', attrs: { fontSize: '13.5px' } });
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' edited');
    const html = editor.getHTML();
    expect(html).toContain('font-size: 24px');
    expect(html).toContain('font-size: 13.5px');
    expect(editor.getText()).toContain('Plain text edited');
    expect(editor.getMarkdown()).toContain('Large text');
    expect(appleNoteUpdateInput({ noteId: note.id, title: note.title, html,
      expectedHtml: original.html, expectedModifiedAt: note.modifiedAt, expectedTitle: note.title }).html).toBe(html);
    const saved = { ...original, html: '<div><b><span style="font-size: 24px">Title</span></b><br></div>' + html };
    expect(noteDocumentReadOnlyReason(saved)).toBeNull();
    const before = editor.getJSON();
    editor.commands.setContent(noteEditorHtml(saved), { parseOptions: { preserveWhitespace: 'full' } });
    expect(editor.getJSON()).toEqual(before);
  } finally { editor.destroy(); }
}));

test('imports a fragmented Apple Notes title as one title and preserves explicit blank lines and line breaks', () => withDom(() => {
  const original = { ...note, title: 'Alpha Beta Gamma', html:
    '<div><h1>Alpha</h1><h1> </h1><h1>Beta</h1><h1> </h1><h1>Gamma</h1><h1><br></h1></div>\n'
    + '<div><br></div>\n<div>First paragraph</div>\n<div><br></div>\n'
    + '<div>Second paragraph</div>\n<div><br>Line one<br>Line two<br></div>\n' };
  const html = noteEditorHtml(original);
  expect(html).not.toContain('<h1>');
  const editor = new Editor({ extensions: noteEditorExtensions(), content: html, parseOptions: { preserveWhitespace: 'full' } });
  try {
    expect<unknown>(editor.getJSON().content).toEqual([
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
      { type: 'paragraph', content: [{ type: 'hardBreak' }, { type: 'text', text: 'Line one' },
        { type: 'hardBreak' }, { type: 'text', text: 'Line two' }] },
    ]);
    const before = editor.getJSON();
    editor.commands.setContent(noteEditorHtml({ ...original, html: '<h1>Alpha Beta Gamma</h1>' + editor.getHTML() }),
      { parseOptions: { preserveWhitespace: 'full' } });
    expect(editor.getJSON()).toEqual(before);
  } finally { editor.destroy(); }
}));

test('keeps distinct headings, repeated blank lines and inline spacing in the body', () => withDom(() => {
  const original = { ...note, html: '<div><h1>Title</h1><p>Body stays</p></div>'
    + '<h2>First heading</h2><h2>Second heading</h2><div><br></div><div><br></div>'
    + '<div>  indented  text<br><br></div>' };
  const html = noteEditorHtml(original);
  const editor = new Editor({ extensions: noteEditorExtensions(), content: html, parseOptions: { preserveWhitespace: 'full' } });
  try {
    const blocks = editor.getJSON().content!;
    expect<unknown>(blocks[0]?.content).toEqual([{ type: 'text', text: 'Body stays' }]);
    expect(blocks.filter(block => block.type === 'heading')).toHaveLength(2);
    expect(blocks.filter(block => block.type === 'paragraph' && !block.content)).toHaveLength(2);
    expect<unknown>(blocks.at(-1)?.content).toEqual([{ type: 'text', text: '  indented  text' }, { type: 'hardBreak' }]);
  } finally { editor.destroy(); }
}));

test('native body heading fragments form one heading per original line through editing and reopening', () => withDom(() => {
  const original = { ...note, html: '<div><b><h1>Title</h1></b><b><h1><br></h1></b></div>\n'
    + '<div><b><h1><br></h1></b></div>\n'
    + '<div><b><h1>First</h1></b><b><h1> </h1></b><b><h1>screen</h1></b>'
    + '<b><h1> </h1></b><b><h1>message</h1></b><b><h1><br></h1></b></div>\n'
    + '<div><b><h1>Apple</h1></b><b><h1> </h1></b><b><h1>Notes</h1></b>'
    + '<b><h1> </h1></b><b><h1>integration</h1></b></div>\n' };
  const html = noteEditorHtml(original);
  expect(html.match(/<h1>/g)).toHaveLength(2);
  const editor = new Editor({ extensions: noteEditorExtensions(), content: html, parseOptions: { preserveWhitespace: 'full' } });
  try {
    const blocks = editor.getJSON().content!;
    expect<unknown>(blocks).toEqual([
      { type: 'paragraph' },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'First screen message', marks: [{ type: 'bold' }] }] },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Apple Notes integration', marks: [{ type: 'bold' }] }] },
    ]);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' edited');
    const savedHtml = editor.getHTML();
    expect(appleNoteUpdateInput({ noteId: note.id, title: note.title, html: savedHtml,
      expectedHtml: original.html, expectedModifiedAt: note.modifiedAt, expectedTitle: note.title }).html).toBe(savedHtml);
    const before = editor.getJSON();
    const saved = { ...note, html: '<div><b><h1>Title</h1></b></div>' + savedHtml };
    expect(noteDocumentReadOnlyReason(saved)).toBeNull();
    editor.commands.setContent(noteEditorHtml(saved), { parseOptions: { preserveWhitespace: 'full' } });
    expect(editor.getJSON()).toEqual(before);
  } finally { editor.destroy(); }
}));

test('heading normalization preserves nested line boundaries, hard breaks, mixed levels and inline styles', () => withDom(() => {
  const original = { ...note, html: '<h1>Title</h1><div>'
    + '<div><h2><i>One</i></h2><h2> </h2><h2><span style="font-size: 13.5px">two</span><br><br></h2></div>'
    + '<div><h2>Next</h2><h2> line</h2></div></div>'
    + '<div><h1>Separate title</h1><h2>Separate subheading</h2></div><div><p>Paragraph</p><h2>Heading</h2></div>' };
  const editor = new Editor({ extensions: noteEditorExtensions(), content: noteEditorHtml(original), parseOptions: { preserveWhitespace: 'full' } });
  try {
    const blocks = editor.getJSON().content!;
    expect(blocks.map(block => block.type)).toEqual(['heading', 'heading', 'heading', 'heading', 'paragraph', 'heading']);
    expect(blocks.map(block => block.attrs?.level)).toEqual([2, 2, 1, 2, undefined, 2]);
    expect(blocks[0]?.content?.[0]?.marks).toContainEqual({ type: 'italic' });
    expect(blocks[0]?.content?.[2]?.marks).toContainEqual({ type: 'noteFontSize', attrs: { fontSize: '13.5px' } });
    expect(blocks[0]?.content?.at(-1)?.type).toBe('hardBreak');
    expect(editor.getText()).toContain('One two\n');
    expect(editor.getText()).toContain('Next line');
    expect(isEditableNoteHtml(editor.getHTML())).toBe(true);
  } finally { editor.destroy(); }
}));

test('markdown headings, lists, quotes, links and code round-trip into supported Apple Notes HTML', () => withDom(() => {
  const editor = new Editor({ extensions: noteEditorExtensions(), content: '# Heading\n\n**Bold** and *italic*\n\n- One\n- Two\n\n> Quote\n\n```ts\nconst n = 1 < 2\n```\n\n[Link](https://example.com)', contentType: 'markdown' });
  try {
    const html = editor.getHTML();
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('const n = 1 &lt; 2');
    expect(isEditableNoteHtml(html)).toBe(true);
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('**Bold**');
    const before = editor.getJSON();
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(before);
    editor.commands.setContent('<p>Undo target</p>');
    editor.commands.insertContent('New ');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.commands.redo()).toBe(true);
  } finally { editor.destroy(); }
}));

test('unsupported original HTML stays read-only and never enters the rich editor', () => withDom(() => {
  for (const html of ['<img src="https://example.com/private.png">', '<table><tr><td>Cell</td></tr></table>', '<div style="color:red">Red</div>', '<script>alert(1)</script>']) {
    const protectedNote = { ...note, html };
    expect(noteDocumentReadOnlyReason(protectedNote)).not.toBeNull();
    expect(noteEditorHtml(protectedNote)).toBe('');
  }
  expect(noteDocumentReadOnlyReason({ ...note, attachmentCount: 1 })).not.toBeNull();
}));
