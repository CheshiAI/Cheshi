import { expect, test } from 'bun:test';
import { act, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatImportAttachment } from '../shared/chat-imports';
import { ChatComposerInput } from '../frontend/src/features/chat/ChatComposerSurface';

const imports: ChatImportAttachment[] = [
  { kind: 'image', name: 'before.png', path: '/attachments/before.png', importNumber: 1 },
  { kind: 'file', name: 'notes.txt', path: '/attachments/notes.txt', importNumber: 12 },
];

type NavigationKeyOptions = Pick<KeyboardEventInit, 'isComposing' | 'keyCode' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat'>;

interface InputHarness {
  render(value: string, attachments?: readonly ChatImportAttachment[], onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void): Promise<void>;
  input(): HTMLTextAreaElement;
  press(key: string, options?: NavigationKeyOptions): Promise<boolean>;
  changeCount(): number;
}

async function withInput(run: (harness: InputHarness) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let changes = 0;
  const input = () => {
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Expected the shared composer textarea.');
    return textarea;
  };
  try {
    await run({
      render: async (value, attachments = imports, onKeyDown) => {
        await act(async () => root.render(<ChatComposerInput value={value} attachments={attachments}
          onChange={() => { changes++; }} onKeyDown={onKeyDown} />));
        input().focus();
      },
      input,
      press: async (key, options = {}) => {
        const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        await act(async () => { input().dispatchEvent(event as unknown as Event); });
        return event.defaultPrevented;
      },
      changeCount: () => changes,
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function selection(input: HTMLTextAreaElement) {
  return [input.selectionStart, input.selectionEnd];
}

test('one horizontal arrow crosses each connected image or file reference without editing the draft', async () => {
  await withInput(async h => {
    const text = '앞 🐈 [import 1] 과 [import 12] 뒤 [import 1]';
    await h.render(text);
    const input = h.input();
    for (const match of text.matchAll(/\[import \d+\]/g)) {
      const start = match.index, end = start + match[0].length;
      input.setSelectionRange(start, start);
      expect(await h.press('ArrowRight')).toBe(true);
      expect(selection(input)).toEqual([end, end]);
      expect(await h.press('ArrowLeft')).toBe(true);
      expect(selection(input)).toEqual([start, start]);
      input.setSelectionRange(start + 3, start + 3);
      expect(await h.press('ArrowRight')).toBe(true);
      expect(selection(input)).toEqual([end, end]);
      input.setSelectionRange(end - 2, end - 2);
      expect(await h.press('ArrowLeft')).toBe(true);
      expect(selection(input)).toEqual([start, start]);
    }
    expect(input.value).toBe(text);
    expect(h.changeCount()).toBe(0);
    expect(input.hasAttribute('attachments')).toBe(false);
  });
});

test('Shift selects and deselects a complete reference in either direction while preserving its anchor', async () => {
  await withInput(async h => {
    const text = '앞 [import 1] 뒤';
    const start = text.indexOf('['), end = text.indexOf(']') + 1;
    await h.render(text);
    const input = h.input();
    input.setSelectionRange(start, start);
    await h.press('ArrowRight', { shiftKey: true });
    expect(selection(input)).toEqual([start, end]);
    expect(input.selectionDirection).toBe('forward');
    await h.press('ArrowLeft', { shiftKey: true });
    expect(selection(input)).toEqual([start, start]);
    input.setSelectionRange(end, end);
    await h.press('ArrowLeft', { shiftKey: true });
    expect(selection(input)).toEqual([start, end]);
    expect(input.selectionDirection).toBe('backward');
    await h.press('ArrowRight', { shiftKey: true });
    expect(selection(input)).toEqual([end, end]);
    input.setSelectionRange(0, start, 'forward');
    await h.press('ArrowRight', { shiftKey: true });
    expect(selection(input)).toEqual([0, end]);
    input.setSelectionRange(end, text.length, 'backward');
    await h.press('ArrowLeft', { shiftKey: true });
    expect(selection(input)).toEqual([start, text.length]);
    expect(input.selectionDirection).toBe('backward');
  });
});

test('mouse selections inside a reference snap to its boundaries without skipping a second unit', async () => {
  await withInput(async h => {
    const text = '[import 1] [import 12]';
    const firstEnd = '[import 1]'.length, secondStart = firstEnd + 1;
    await h.render(text);
    const input = h.input();
    input.setSelectionRange(3, 3);
    await h.press('ArrowRight', { shiftKey: true });
    expect(selection(input)).toEqual([0, firstEnd]);
    input.setSelectionRange(3, 3);
    await h.press('ArrowLeft', { shiftKey: true });
    expect(selection(input)).toEqual([0, firstEnd]);
    expect(input.selectionDirection).toBe('backward');
    input.setSelectionRange(2, firstEnd - 2);
    await h.press('ArrowLeft');
    expect(selection(input)).toEqual([0, 0]);
    input.setSelectionRange(2, firstEnd - 2);
    await h.press('ArrowRight');
    expect(selection(input)).toEqual([firstEnd, firstEnd]);
    input.setSelectionRange(2, secondStart, 'forward');
    await h.press('ArrowRight', { shiftKey: true });
    expect(selection(input)).toEqual([0, text.length]);
    input.setSelectionRange(0, firstEnd);
    expect(await h.press('ArrowRight')).toBe(false);
    expect(await h.press('ArrowLeft')).toBe(false);
  });
});

test('held arrow keys cross adjacent references one at a time and stop intercepting at text boundaries', async () => {
  await withInput(async h => {
    const labels = ['[import 1]', '[import 12]', '[import 1]'];
    const text = labels.join('');
    await h.render(text);
    const input = h.input();
    let caret = 0;
    input.setSelectionRange(caret, caret);
    for (const label of labels) {
      expect(await h.press('ArrowRight', { repeat: true })).toBe(true);
      caret += label.length;
      expect(selection(input)).toEqual([caret, caret]);
    }
    expect(await h.press('ArrowRight')).toBe(false);
    for (const label of [...labels].reverse()) {
      expect(await h.press('ArrowLeft', { repeat: true })).toBe(true);
      caret -= label.length;
      expect(selection(input)).toEqual([caret, caret]);
    }
    expect(await h.press('ArrowLeft')).toBe(false);
  });
});

test('unconnected, malformed and removed references retain native text navigation', async () => {
  await withInput(async h => {
    for (const text of ['[import 99]', '[import 01]', '[import 0]', '[import -1]', '[import 1']) {
      await h.render(text);
      h.input().setSelectionRange(0, 0);
      expect(await h.press('ArrowRight')).toBe(false);
    }
    await h.render('[import 12]', imports.slice(0, 1));
    h.input().setSelectionRange(0, 0);
    expect(await h.press('ArrowRight')).toBe(false);
    await h.render('[import 1]', []);
    h.input().setSelectionRange(0, 0);
    expect(await h.press('ArrowRight')).toBe(false);
    await h.render('[import 1]');
    h.input().setSelectionRange(0, 0);
    expect(await h.press('ArrowRight')).toBe(true);
  });
});

test('IME composition, native shortcuts and consumer keyboard handlers retain priority', async () => {
  await withInput(async h => {
    await h.render('[import 1]');
    const input = h.input();
    for (const options of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      input.setSelectionRange(0, 0);
      expect(await h.press('ArrowRight', options)).toBe(false);
      expect(selection(input)).toEqual([0, 0]);
    }
    const forwarded: string[] = [];
    await h.render('[import 1]', imports, event => { forwarded.push(event.key); event.preventDefault(); });
    input.setSelectionRange(0, 0);
    expect(await h.press('ArrowRight')).toBe(true);
    expect(selection(input)).toEqual([0, 0]);
    expect(forwarded).toEqual(['ArrowRight']);
    await h.render('[import 1]');
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Tab', 'Backspace', 'Delete', 'a']) {
      expect(await h.press(key)).toBe(false);
    }
  });
});
