import { expect, test } from 'bun:test';
import { installDragCopy } from '../shared/drag-copy';
import { readEditorStateSelection } from '../frontend/src/shared/selectionCopy';
import { EditorSelection, EditorState } from '@codemirror/state';

class TestElement {
  tagName = 'DIV';
  type = 'text';
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  value = '';
  separator = false;
  readonly ownerDocument: TestDocument;
  constructor(document: TestDocument) { this.ownerDocument = document; }
  contains(node: unknown) { return node === this; }
  closest(selector: string): TestElement | null {
    if (selector === 'input, textarea') return ['INPUT', 'TEXTAREA'].includes(this.tagName) ? this : null;
    return this.separator || this.type === 'password' ? this : null;
  }
}

class TestDocument {
  readonly listeners = new Map<string, Set<EventListener>>();
  text = '';
  anchor: TestElement | null = null;
  offset = 0;
  activeElement: TestElement | null = null;
  readonly timers = new Map<number, () => void>();
  private nextTimer = 1;
  readonly defaultView = {
    Element: TestElement,
    setTimeout: (run: () => void) => { const id = this.nextTimer++; this.timers.set(id, run); return id; },
    clearTimeout: (id: number) => { this.timers.delete(id); },
    addEventListener: (type: string, listener: EventListener) => this.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListener) => this.removeEventListener(type, listener),
  };
  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  getSelection() {
    return { isCollapsed: !this.text.length, anchorNode: this.anchor, focusNode: this.anchor,
      anchorOffset: this.offset, focusOffset: this.offset + this.text.length,
      toString: () => this.text, containsNode: () => false };
  }
  emit(type: string, target: TestElement, options: Record<string, unknown> = {}) {
    const event = { isTrusted: true, button: 0, buttons: 1, pointerType: 'mouse', pointerId: 1,
      clientX: 0, clientY: 0, composedPath: () => [target], ...options } as unknown as Event;
    this.listeners.get(type)?.forEach(listener => listener(event));
  }
  flush() { const timers = [...this.timers.values()]; this.timers.clear(); timers.forEach(run => run()); }
}

function setup(write?: (text: string) => Promise<unknown> | void) {
  const document = new TestDocument();
  const target = new TestElement(document);
  const copies: string[] = [];
  const dispose = installDragCopy(document as unknown as Document, write ?? (text => { copies.push(text); }));
  function select(text: string) {
    document.anchor = target; document.text = text; document.emit('selectionchange', target);
  }
  function end() { document.emit('pointerup', target, { clientX: 20 }); document.flush(); }
  return { document, target, copies, dispose, select, end };
}

test('chat and help DOM selections copy after release, preserving whitespace and subsequent selections', () => {
  const app = setup();
  for (const text of ['  first\n\tsecond  \n', 'new text', '   \n\t']) {
    app.document.emit('pointerdown', app.target);
    app.select('');
    app.document.emit('pointermove', app.target, { clientX: 10 });
    app.select(text);
    const before = app.copies.length;
    app.document.emit('pointerup', app.target, { clientX: 20 });
    expect(app.copies).toHaveLength(before);
    app.document.flush();
    expect(app.copies.at(-1)).toBe(text);
  }
});

test('input and textarea use their value range, including reverse selection and unchanged repeated text', () => {
  for (const tagName of ['INPUT', 'TEXTAREA']) {
    const app = setup(); app.target.tagName = tagName; app.target.value = 'before  selected\n\ttext  after';
    app.document.emit('pointerdown', app.target);
    app.target.selectionStart = 6; app.target.selectionEnd = 23;
    app.end();
    expect(app.copies).toEqual([app.target.value.slice(6, 23)]);
    app.document.emit('pointerdown', app.target);
    app.target.selectionStart = 6; app.target.selectionEnd = 6;
    app.document.emit('selectionchange', app.target);
    app.target.selectionEnd = 23;
    app.end();
    expect(app.copies).toHaveLength(2);
  }
});

test('clicks, empty selections, unrelated drags, passwords, untrusted events and touch leave clipboard unchanged', () => {
  const app = setup(); app.select('old selection');
  app.document.emit('pointerdown', app.target);
  app.document.emit('pointerup', app.target);
  app.document.flush();
  app.document.emit('pointerdown', app.target); app.end();
  const unrelated = new TestElement(app.document);
  app.document.emit('pointerdown', unrelated); app.select('changed elsewhere');
  app.document.emit('pointerup', unrelated, { clientX: 20 }); app.document.flush();
  app.target.separator = true;
  app.document.emit('pointerdown', app.target); app.select('resize'); app.end();
  app.target.separator = false; app.target.type = 'password'; app.target.tagName = 'INPUT';
  app.target.value = 'secret'; app.target.selectionStart = 0; app.target.selectionEnd = 6;
  app.document.emit('pointerdown', app.target); app.end();
  app.target.type = 'text'; app.target.tagName = 'DIV';
  app.document.emit('pointerdown', app.target, { isTrusted: false }); app.select('script'); app.end();
  app.document.emit('pointerdown', app.target, { pointerType: 'touch' }); app.select('touch'); app.end();
  app.document.emit('pointerdown', app.target); app.select(''); app.end();
  expect(app.copies).toEqual([]);
});

test('numeric and email controls use the focused Chromium selection when range APIs are unavailable', () => {
  for (const type of ['number', 'email']) {
    const app = setup();
    app.target.tagName = 'INPUT'; app.target.type = type;
    app.document.activeElement = app.target;
    app.document.emit('pointerdown', app.target);
    app.select(type === 'number' ? '123' : 'name@example.com');
    app.end();
    expect(app.copies).toEqual([app.document.text]);
  }
});

test('manual copy, editing, native drag/drop, lost capture and blur cancel pending auto copy', () => {
  for (const event of ['copy', 'cut', 'keydown', 'dragstart', 'pointercancel', 'blur']) {
    const app = setup();
    app.document.emit('pointerdown', app.target); app.select('selected');
    app.document.emit('pointerup', app.target, { clientX: 20 });
    app.document.emit(event, app.target); app.document.flush();
    expect(app.copies).toEqual([]);
    expect(app.document.text).toBe('selected');
  }
});

test('clipboard failure and disposal preserve content and do not leave handlers behind', async () => {
  for (const write of [() => { throw new Error('denied'); }, () => Promise.reject(new Error('denied'))]) {
    const app = setup(write);
    app.document.emit('pointerdown', app.target); app.select('keep text'); app.end();
    await Promise.resolve();
    expect(app.document.text).toBe('keep text');
    app.dispose();
    expect([...app.document.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  }
});

test('CodeMirror selections use full document state, including offscreen lines and multiple ranges', () => {
  const doc = '  first  \n' + 'line\n'.repeat(300) + '\tlast  ';
  const state = EditorState.create({ doc, selection: { anchor: doc.length, head: 0 } });
  expect(readEditorStateSelection({ state })?.text).toBe(doc);
  const multiple = EditorState.create({ doc, extensions: EditorState.allowMultipleSelections.of(true),
    selection: EditorSelection.create([EditorSelection.range(0, 4), EditorSelection.range(doc.length - 7, doc.length)]) });
  expect(readEditorStateSelection({ state: multiple })?.text).toBe('  fi\n\tlast  ');
  expect(readEditorStateSelection({ state: EditorState.create({ doc }) })).toBeNull();
});
