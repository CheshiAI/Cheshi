import { expect, test } from 'bun:test';
import { act, createRef, type ComponentProps, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { Window } from 'happy-dom';
import { ChatImportInput } from '../frontend/src/features/chat/ChatImportInput';
import { handleChatComposerKey } from '../frontend/src/features/chat/chatComposerKeyboard';
import type { ChatInputHandle } from '../frontend/src/features/chat/chatInputHandle';
import { messageWithChatImports, type ChatImportAttachment } from '../shared/chat-imports';
import { useChatDraft } from '../frontend/src/features/chat/useChatDraft';
import { useChatImportDraft } from '../frontend/src/features/chat/useChatImportDraft';
import { useChatInputHistory } from '../frontend/src/features/chat/useChatInputHistory';
import { WORKSPACE_FILE_TRANSFER_TYPE } from '../frontend/src/shared/workspaceFileTransfer';
import type { CodexChatAttachment } from '../frontend/src/cheshiDesktop';
import type { ChatDraftSnapshot } from '../frontend/src/features/chat/chatDraftRecovery';
import { chatLocalPathReferences } from '../frontend/src/features/chat/chatLocalPathEditor';

const attachments: CodexChatAttachment[] = [
  { kind: 'image', name: 'before.png', path: '/attachments/before.png', previewUrl: 'attachment://before.png', importNumber: 1 },
  { kind: 'file', name: 'notes.txt', path: '/attachments/notes.txt', importNumber: 12 },
];
type Props = ComponentProps<typeof ChatImportInput>;
type KeyOptions = Pick<KeyboardEventInit, 'keyCode' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>;

async function withInput(run: (harness: {
  window: Window;
  input(): ChatInputHandle;
  view(): EditorView;
  attachments(): readonly ChatImportAttachment[] | undefined;
  render(value: string, options?: Partial<Props>): Promise<void>;
  mount(node: ReactNode): Promise<void>;
  press(key: string, options?: KeyOptions): Promise<boolean>;
  insert(text: string, userEvent?: string): Promise<void>;
  changes: string[];
}) => Promise<void>) {
  const window = new Window();
  const globals = {
    window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<ChatInputHandle>();
  const changes: string[] = [];
  let props: Props;
  const draw = () => root.render(<ChatImportInput {...props} ref={ref} />);
  const view = () => {
    const content = container.querySelector<HTMLElement>('.cm-content');
    const result = content && EditorView.findFromDOM(content);
    if (!result) throw new Error('Expected the attachment-aware composer.');
    return result;
  };
  props = { value: '', attachments, historyKey: 'session-a', 'aria-label': 'Message', onChange: (value, imports) => {
    changes.push(value); props = { ...props, value, ...(imports === undefined ? {} : { attachments: imports }) }; draw();
  } };
  try {
    await run({
      window, changes, input: () => ref.current!, view, attachments: () => props.attachments,
      mount: async node => { await act(async () => root.render(node)); },
      render: async (value, options = {}) => {
        props = { ...props, ...options, value };
        await act(async () => { draw(); });
      },
      press: async (key, options = {}) => {
        const codes: Record<string, number> = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Enter: 13, Backspace: 8, Delete: 46, Tab: 9 };
        const event = new window.KeyboardEvent('keydown', { key, keyCode: codes[key], bubbles: true, cancelable: true, ...options });
        await act(async () => { view().contentDOM.dispatchEvent(event as unknown as Event); });
        return event.defaultPrevented;
      },
      insert: async (text, userEvent = 'input.type') => {
        await act(async () => { view().dispatch({ ...view().state.replaceSelection(text), userEvent }); });
      },
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

function selection(input: ChatInputHandle) { return [input.selectionStart, input.selectionEnd]; }

test('local path matching supports quoted names and dropped links without consuming commands, URLs or fenced code', () => {
  const text = '/Users/cheshi/project\n"/Users/체시/My File.txt" \'/tmp/a b\' `/tmp/code.txt` [folder](</tmp/my%20folder>)';
  expect(chatLocalPathReferences(text).map(item => item.path))
    .toEqual(['/Users/cheshi/project', '/Users/체시/My File.txt', '/tmp/a b', '/tmp/code.txt', '/tmp/my folder']);
  expect(chatLocalPathReferences('/model https://example.com/a/b [web](https://example.com/a/b) ![image](/tmp/a.png)\n```sh\n/tmp/example\n```\n~~~\n/tmp/other\n~~~')).toEqual([]);
  expect(chatLocalPathReferences('See (/tmp/file.txt), then /tmp/next.').map(item => item.path)).toEqual(['/tmp/file.txt', '/tmp/next']);
});

test('paths appear as filename chips while copy, paste and clicks retain the full original target', async () => {
  await withInput(async h => {
    const opened: string[] = [];
    const draft = '앞 "/Users/체시/My File.txt" /tmp/notes.md [import 1]';
    await h.render(draft, { onOpenLocalFile: async href => { opened.push(href); } });
    const chips = h.view().contentDOM.querySelectorAll<HTMLAnchorElement>('[data-chat-local-path]');
    expect(Array.from(chips, chip => chip.textContent)).toEqual(['My File.txt', 'notes.md']);
    expect(chips[0]?.title).toBe('/Users/체시/My File.txt');
    expect(h.view().contentDOM.querySelectorAll('[data-chat-import-number]')).toHaveLength(1);
    expect(h.input().value).toBe(draft);
    await act(async () => { chips[0]!.click(); });
    expect(opened).toEqual(['/Users/%EC%B2%B4%EC%8B%9C/My%20File.txt']);
    h.input().focus();
    h.input().setSelectionRange(0, draft.length);
    const data = new h.window.DataTransfer();
    await act(async () => { h.view().contentDOM.dispatchEvent(new h.window.ClipboardEvent('copy',
      { clipboardData: data, bubbles: true, cancelable: true }) as unknown as Event); });
    expect(data.getData('text/plain')).toBe(draft);
    h.input().setSelectionRange(draft.length, draft.length);
    const paste = new h.window.DataTransfer();
    paste.setData('text/plain', '\n/tmp/pasted.txt');
    await act(async () => { h.view().contentDOM.dispatchEvent(new h.window.ClipboardEvent('paste',
      { clipboardData: paste, bubbles: true, cancelable: true }) as unknown as Event); });
    expect(h.input().value).toBe(`${draft}\n/tmp/pasted.txt`);
    expect(h.view().contentDOM.querySelectorAll('[data-chat-local-path]')).toHaveLength(3);
  });
});

test('path chips support atomic cursor movement, selection, deletion and Undo without detaching imports', async () => {
  await withInput(async h => {
    const path = '"/tmp/My [import 1].txt"';
    const draft = `앞 ${path} 뒤 [import 1]`;
    await h.render(draft);
    const start = 2, end = start + path.length;
    h.input().setSelectionRange(start + 1, start + 1);
    expect(selection(h.input())).toEqual([start, start]);
    await h.press('ArrowRight');
    expect(selection(h.input())).toEqual([end, end]);
    await h.press('ArrowLeft', { shiftKey: true });
    expect(selection(h.input())).toEqual([start, end]);
    await h.press('Backspace');
    expect(h.input().value).toBe('앞  뒤 [import 1]');
    expect(h.attachments()).toEqual(attachments);
    await act(async () => { expect(undo(h.view())).toBe(true); });
    expect(h.input().value).toBe(draft);
    expect(h.view().contentDOM.querySelectorAll('[data-chat-local-path]')).toHaveLength(1);
    expect(h.view().contentDOM.querySelectorAll('[data-chat-import-number]')).toHaveLength(1);
  });
});

test('disabled path chips cannot open files and file-open errors do not replace the draft', async () => {
  await withInput(async h => {
    let opens = 0;
    const onOpenLocalFile = async () => { opens++; throw new Error('gone'); };
    await h.render('/tmp/gone.txt', { disabled: true, onOpenLocalFile });
    const click = async () => { await act(async () => { h.view().contentDOM.querySelector<HTMLAnchorElement>('[data-chat-local-path]')!.click(); }); };
    await click();
    expect(opens).toBe(0);
    await h.render('/tmp/gone.txt', { disabled: false });
    await click();
    expect(opens).toBe(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not open');
    expect(h.input().value).toBe('/tmp/gone.txt');
  });
});

test('only connected references render bracket-free chips while the transmitted draft stays exact', async () => {
  await withInput(async h => {
    const draft = '이 [import 1]을 [import 12]처럼 🐈\n[import 999] [import 01]';
    await h.render(draft);
    const chips = h.view().contentDOM.querySelectorAll('[data-chat-import-number]');
    expect(Array.from(chips, chip => chip.textContent)).toEqual(['import 1', 'import 12']);
    expect(chips[0]?.getAttribute('aria-label')).toBe('import 1: before.png');
    expect(h.view().contentDOM.textContent).not.toContain('[import 1]');
    expect(h.view().contentDOM.textContent).toContain('[import 999]');
    expect(h.input().value).toBe(draft);
    expect(h.changes).toEqual([]);
    expect(h.view().contentDOM.getAttribute('aria-label')).toBe('Message');
    expect(h.view().contentDOM.getAttribute('aria-multiline')).toBe('true');
  });
});

test('horizontal arrows and Shift selection cross whole chips in either direction', async () => {
  await withInput(async h => {
    const draft = '앞 [import 1][import 12] 뒤';
    await h.render(draft);
    const first = draft.indexOf('['), middle = first + '[import 1]'.length, last = middle + '[import 12]'.length;
    h.input().setSelectionRange(first, first);
    expect(await h.press('ArrowRight')).toBe(true);
    expect(selection(h.input())).toEqual([middle, middle]);
    await h.press('ArrowRight', { repeat: true });
    expect(selection(h.input())).toEqual([last, last]);
    await h.press('ArrowLeft');
    expect(selection(h.input())).toEqual([middle, middle]);
    await h.press('ArrowLeft', { shiftKey: true });
    expect(selection(h.input())).toEqual([first, middle]);
    expect(h.input().selectionDirection).toBe('backward');
    await h.press('ArrowRight', { shiftKey: true });
    expect(selection(h.input())).toEqual([middle, middle]);
    h.input().setSelectionRange(first, first);
    await h.press('ArrowRight', { shiftKey: true });
    expect(selection(h.input())).toEqual([first, middle]);
    expect(h.input().value).toBe(draft);
    expect(h.changes).toEqual([]);
  });
});

test('restored cursor and partial selections cannot land in the hidden bracket text', async () => {
  await withInput(async h => {
    const draft = '앞 [import 1] 뒤';
    await h.render(draft);
    const start = draft.indexOf('['), end = draft.indexOf(']') + 1;
    h.input().setSelectionRange(start + 1, start + 1);
    expect(selection(h.input())).toEqual([start, start]);
    h.input().setSelectionRange(end - 1, end - 1);
    expect(selection(h.input())).toEqual([end, end]);
    h.input().setSelectionRange(start + 1, end - 1, 'backward');
    expect(selection(h.input())).toEqual([start, end]);
    expect(h.input().selectionDirection).toBe('backward');
  });
});

test('deletion and undo preserve complete references and unrelated Korean text', async () => {
  await withInput(async h => {
    const draft = '앞 [import 1] 뒤';
    const start = draft.indexOf('['), end = draft.indexOf(']') + 1;
    await h.render(draft);
    h.input().setSelectionRange(end, end);
    await h.press('Backspace');
    expect(h.input().value).toBe('앞  뒤');
    expect(h.changes).toEqual(['앞  뒤']);
    expect(h.attachments()).toEqual([attachments[1]!]);
    await act(async () => { expect(undo(h.view())).toBe(true); });
    expect(h.input().value).toBe(draft);
    expect(h.attachments()).toEqual(attachments);
    expect(h.view().contentDOM.querySelector('[data-chat-import-number]')?.textContent).toBe('import 1');
    await act(async () => { expect(redo(h.view())).toBe(true); });
    expect(h.input().value).toBe('앞  뒤');
    expect(h.attachments()).toEqual([attachments[1]!]);
    await act(async () => { undo(h.view()); });
    h.input().setSelectionRange(start, start);
    await h.press('Delete');
    expect(h.input().value).toBe('앞  뒤');
    expect(h.attachments()).toEqual([attachments[1]!]);
  });
});

test('clipboard copy retains import labels and plain-text paste restores matching chips', async () => {
  await withInput(async h => {
    const draft = '[import 1]을 [import 12]처럼';
    await h.render(draft);
    await act(async () => { h.input().focus(); });
    h.input().setSelectionRange(0, draft.length);
    const data = new h.window.DataTransfer();
    const copy = new h.window.ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    await act(async () => { h.view().contentDOM.dispatchEvent(copy as unknown as Event); });
    expect(data.getData('text/plain')).toBe(draft);
    h.input().setSelectionRange(draft.length, draft.length);
    const pasteData = new h.window.DataTransfer();
    pasteData.setData('text/plain', '\n[import 1] 한글 🐈');
    const paste = new h.window.ClipboardEvent('paste', { clipboardData: pasteData, bubbles: true, cancelable: true });
    await act(async () => { h.view().contentDOM.dispatchEvent(paste as unknown as Event); });
    expect(h.input().value).toBe(`${draft}\n[import 1] 한글 🐈`);
    expect(h.view().contentDOM.querySelectorAll('[data-chat-import-number]')).toHaveLength(3);
  });
});

test('file paste handlers run before text insertion and do not consume the current selection', async () => {
  await withInput(async h => {
    let pasted = 0;
    await h.render('보관 [import 1]', { onPaste: event => { pasted++; event.preventDefault(); } });
    h.input().setSelectionRange(0, 2);
    const data = new h.window.DataTransfer();
    data.setData('text/plain', 'must not replace the draft');
    const paste = new h.window.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    await act(async () => { h.view().contentDOM.dispatchEvent(paste as unknown as Event); });
    expect(pasted).toBe(1);
    expect(h.input().value).toBe('보관 [import 1]');
    expect(selection(h.input())).toEqual([0, 2]);
  });
});

test('composer shortcuts take priority while Shift-Enter and IME Enter remain input operations', async () => {
  await withInput(async h => {
    let submits = 0, menuMoves = 0;
    let menuOpen = false;
    const onKeyDown: Props['onKeyDown'] = event => handleChatComposerKey(event, {
      locked: false, menuOpen, goalOpen: false, pickerOpen: menuOpen,
      closeMenu() {}, saveGoal() {}, moveOption() { menuMoves++; }, activateOption() {},
      enqueue: () => false, submit() { submits++; },
    });
    await h.render('[import 1]', { onKeyDown });
    h.input().setSelectionRange(10, 10);
    await h.press('Enter', { isComposing: true });
    await h.press('Enter', { keyCode: 229 });
    expect(submits).toBe(0);
    expect(h.input().value).toBe('[import 1]');
    await h.insert('한글', 'input.type.compose');
    expect(h.input().value).toBe('[import 1]한글');
    await h.press('Enter', { shiftKey: true });
    expect(h.input().value).toBe('[import 1]한글\n');
    await h.press('Enter');
    expect(submits).toBe(1);
    expect(h.input().value).toBe('[import 1]한글\n');
    menuOpen = true;
    await h.press('ArrowUp');
    expect(menuMoves).toBe(1);
  });
});

test('external attachment insertion can be undone without recreating the editor on ordinary renders', async () => {
  await withInput(async h => {
    await h.render('앞 뒤');
    const view = h.view();
    await h.render('앞 [import 1] 뒤');
    h.input().setSelectionRange(12, 12);
    const chip = h.view().contentDOM.querySelector('[data-chat-import-number]');
    await h.render('앞 [import 1] 뒤', { placeholder: 'Changed placeholder' });
    expect(h.view()).toBe(view);
    expect(h.view().contentDOM.querySelector('[data-chat-import-number]')).toBe(chip);
    expect(h.changes).toEqual([]);
    await act(async () => { undo(h.view()); });
    expect(h.input().value).toBe('앞 뒤');
    await act(async () => { redo(h.view()); });
    expect(h.input().value).toBe('앞 [import 1] 뒤');
  });
});

test('switching sessions and clearing a sent draft discard undo history from the previous message', async () => {
  await withInput(async h => {
    await h.render('first [import 1]');
    h.input().setSelectionRange(16, 16);
    await h.insert(' added');
    await h.render('second [import 12]', { historyKey: 'session-b' });
    await act(async () => { expect(undo(h.view())).toBe(false); });
    expect(h.input().value).toBe('second [import 12]');
    h.input().setSelectionRange(18, 18);
    await h.insert(' sent');
    await h.render('');
    await act(async () => { expect(undo(h.view())).toBe(false); });
    expect(h.input().value).toBe('');
  });
});

test('removed attachments lose their chip, and read-only or disabled input cannot be changed by deletion', async () => {
  await withInput(async h => {
    await h.render('[import 1] [import 12]', { readOnly: true });
    h.input().setSelectionRange(10, 10);
    await h.press('Backspace');
    expect(h.input().value).toBe('[import 1] [import 12]');
    await h.render('[import 1] [import 12]', { attachments: [attachments[1]!], readOnly: false, disabled: true });
    expect(h.view().contentDOM.querySelectorAll('[data-chat-import-number]')).toHaveLength(1);
    expect(h.view().contentDOM.textContent).toContain('[import 1]');
    expect(h.view().contentDOM.getAttribute('tabindex')).toBe('-1');
    await h.press('Backspace');
    expect(h.input().value).toBe('[import 1] [import 12]');
    expect(h.changes).toEqual([]);
  });
});

test('attachment insertion and history restoration share the real editor caret without submitting', async () => {
  await withInput(async h => {
    const ref = createRef<ChatInputHandle>();
    let state!: ReturnType<typeof useChatDraft>;
    let imports!: ReturnType<typeof useChatImportDraft>;
    let history!: ReturnType<typeof useChatInputHistory>;
    let submitted = 0;
    const restoredText = '이전 [import 12]';
    const items = [{ id: 'previous', kind: 'user' as const, createdAt: 1,
      text: messageWithChatImports(restoredText, [attachments[1]!]) }];
    function Fixture() {
      state = useChatDraft(0, async () => ({ status: 'accepted' }));
      imports = useChatImportDraft(state.draft, ref, state.editInput, true);
      history = useChatInputHistory({ scope: 'fixture', items, draft: state.draft, disabled: false, textareaRef: ref,
        setDraft: imports.restoreInputHistory, onKeyDown: event => {
          if (event.key === 'Enter') { event.preventDefault(); submitted++; }
        } });
      return <div onKeyUp={history.onKeyUp}>
        <ChatImportInput ref={ref} value={state.draft} attachments={state.attachments} historyKey="fixture"
          onChange={imports.updateDraft} onKeyDown={history.onKeyDown} />
      </div>;
    }
    await h.mount(<Fixture />);
    await act(async () => { state.setDraft('앞 뒤'); });
    ref.current!.focus();
    ref.current!.setSelectionRange(2, 2);
    await act(async () => { imports.addAttachments([attachments[0]!]); });
    expect(state.draft).toBe('앞 [import 1] 뒤');
    expect(state.draft.slice(ref.current!.selectionStart)).toBe('뒤');
    expect(h.view().contentDOM.querySelectorAll('[data-chat-import-number]')).toHaveLength(1);
    expect(document.activeElement).toBe(h.view().contentDOM);
    ref.current!.setSelectionRange(state.draft.length, state.draft.length);
    await act(async () => { imports.insertAttachmentReference(attachments[0]!.path); });
    expect(state.draft).toBe('앞 [import 1] 뒤 [import 1] ');
    expect(ref.current!.selectionStart).toBe(state.draft.length);
    await act(async () => { state.setDraft(''); });
    await h.press('ArrowUp');
    expect(history.open).toBe(true);
    await h.press('Enter');
    expect(history.open).toBe(false);
    expect(submitted).toBe(0);
    expect(state.draft).toBe(restoredText);
    expect(ref.current!.selectionStart).toBe(restoredText.length);
    expect(h.view().contentDOM.querySelector('[data-chat-import-number]')?.textContent).toBe('import 12');
    await h.press('Enter', { repeat: true });
    expect(submitted).toBe(0);
  });
});

test('Explorer file drops still reach the owning composer without inserting their transfer payload', async () => {
  await withInput(async h => {
    await h.render('keep [import 1]');
    let dropped = '';
    const handler = (event: DragEvent) => { dropped = event.dataTransfer?.getData(WORKSPACE_FILE_TRANSFER_TYPE) ?? ''; };
    document.addEventListener('drop', handler);
    try {
      const data = new h.window.DataTransfer();
      const paths = JSON.stringify(['/workspace/notes.txt']);
      data.setData(WORKSPACE_FILE_TRANSFER_TYPE, paths);
      data.setData('text/plain', paths);
      const drop = new h.window.Event('drop', { bubbles: true, cancelable: true });
      // Happy DOM's DragEvent does not implement the browser's DataTransfer property.
      Object.defineProperty(drop, 'dataTransfer', { value: data });
      await act(async () => { h.view().contentDOM.dispatchEvent(drop as unknown as Event); });
      expect(drop.defaultPrevented).toBe(true);
      expect(dropped).toBe(paths);
      expect(h.input().value).toBe('keep [import 1]');
    } finally { document.removeEventListener('drop', handler); }
  });
});

test('duplicate references retain their attachment until the last chip is deleted', async () => {
  await withInput(async h => {
    const draft = '[import 1][import 1][import 12]';
    await h.render(draft);
    h.input().setSelectionRange(0, 0);
    await h.press('Delete');
    expect(h.attachments()).toEqual(attachments);
    await h.press('Delete');
    expect(h.attachments()).toEqual([attachments[1]!]);
    expect(h.input().value).toBe('[import 12]');
    await h.press('Delete');
    expect(h.attachments()).toEqual([]);
    expect(h.input().value).toBe('');
    // Repeated adjacent deletions form one Undo group, including both attachment snapshots.
    await act(async () => { expect(undo(h.view())).toBe(true); });
    expect(h.input().value).toBe(draft);
    expect(h.attachments()).toEqual(attachments);
    await act(async () => { expect(redo(h.view())).toBe(true); });
    expect(h.input().value).toBe('');
    expect(h.attachments()).toEqual([]);
  });
});

for (const operation of ['delete', 'replace', 'cut'] as const) {
  test(`select-all ${operation} removes images and files, with Undo restoring both`, async () => {
    await withInput(async h => {
      const draft = '[import 1]을 [import 12]처럼';
      await h.render(draft);
      await act(async () => { h.input().focus(); });
      h.input().setSelectionRange(0, draft.length);
      if (operation === 'cut') {
        const data = new h.window.DataTransfer();
        const cut = new h.window.ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true });
        await act(async () => { h.view().contentDOM.dispatchEvent(cut as unknown as Event); });
        expect(data.getData('text/plain')).toBe(draft);
      } else if (operation === 'replace') await h.insert('새 질문');
      else await h.press('Backspace');
      expect(h.input().value).toBe(operation === 'replace' ? '새 질문' : '');
      expect(h.attachments()).toEqual([]);
      await act(async () => { expect(undo(h.view())).toBe(true); });
      expect(h.input().value).toBe(draft);
      expect(h.attachments()).toEqual(attachments);
      expect(h.view().contentDOM.querySelectorAll('[data-chat-import-number]')).toHaveLength(2);
    });
  });
}

test('legacy attachments stay attached and retyping a deleted label does not resurrect its file', async () => {
  await withInput(async h => {
    const legacy: CodexChatAttachment = { kind: 'file', name: 'legacy.txt', path: '/attachments/legacy.txt' };
    await h.render('[import 1]', { attachments: [...attachments, legacy] });
    h.input().setSelectionRange(0, 10);
    await h.press('Backspace');
    expect(h.attachments()).toEqual([attachments[1]!, legacy]);
    await h.insert('[import 1]');
    expect(h.attachments()).toEqual([attachments[1]!, legacy]);
    expect(h.view().contentDOM.querySelectorAll('[data-chat-import-number]')).toHaveLength(0);
  });
});

test('a new attachment reusing a deleted number keeps the right identity across Undo and Redo', async () => {
  await withInput(async h => {
    const first = attachments[0]!;
    const second: CodexChatAttachment = { kind: 'image', name: 'second.png', path: '/attachments/second.png',
      previewUrl: 'attachment://second.png', importNumber: 1 };
    await h.render('[import 1]', { attachments: [first] });
    h.input().setSelectionRange(0, 10);
    await h.press('Backspace');
    await h.render('[import 1]', { attachments: [second] });
    await act(async () => { expect(undo(h.view())).toBe(true); });
    expect(h.input().value).toBe('');
    expect(h.attachments()).toEqual([]);
    await act(async () => { expect(undo(h.view())).toBe(true); });
    expect(h.attachments()).toEqual([first]);
    await act(async () => { expect(redo(h.view())).toBe(true); });
    expect(h.attachments()).toEqual([]);
    await act(async () => { expect(redo(h.view())).toBe(true); });
    expect(h.attachments()).toEqual([second]);
    expect(h.view().contentDOM.querySelector('[data-chat-import-number]')?.getAttribute('title')).toBe(second.name);
  });
});

test('plain command input does not publish an empty attachment list', async () => {
  await withInput(async h => {
    const changes: (readonly ChatImportAttachment[] | undefined)[] = [];
    await h.render('/model', { attachments: undefined, onChange: (_value, imports) => { changes.push(imports); } });
    h.input().setSelectionRange(6, 6);
    await h.insert(' search');
    expect(changes).toEqual([undefined]);
  });
});

test('sending an attachment-only legacy draft clears attachment Undo history', async () => {
  await withInput(async h => {
    const legacy: CodexChatAttachment = { kind: 'file', name: 'legacy.txt', path: '/attachments/legacy.txt' };
    await h.render('[import 1]', { attachments: [attachments[0]!, legacy] });
    h.input().setSelectionRange(0, 10);
    await h.press('Backspace');
    expect(h.input().value).toBe('');
    expect(h.attachments()).toEqual([legacy]);
    await h.render('', { attachments: [] });
    await act(async () => { expect(undo(h.view())).toBe(false); });
    expect(h.input().value).toBe('');
    expect(h.attachments()).toEqual([]);
  });
});

test('the main draft sends only remaining imports and cannot undo into a sent message', async () => {
  await withInput(async h => {
    const ref = createRef<ChatInputHandle>();
    const sent: ChatDraftSnapshot[] = [];
    let state!: ReturnType<typeof useChatDraft>;
    function Fixture() {
      state = useChatDraft(0, async input => { sent.push(input); return { status: 'accepted' }; });
      const imports = useChatImportDraft(state.draft, ref, state.editInput, true);
      return <ChatImportInput ref={ref} value={state.draft} attachments={state.attachments} historyKey="fixture"
        onChange={imports.updateDraft} />;
    }
    await h.mount(<Fixture />);
    await act(async () => { state.editInput(input => ({ ...input, draft: '[import 1] [import 12]', attachments })); });
    ref.current!.setSelectionRange(0, 10);
    await h.press('Backspace');
    expect(state.attachments).toEqual([attachments[1]!]);
    await act(async () => { undo(h.view()); });
    expect(state.attachments).toEqual(attachments);
    await act(async () => { redo(h.view()); });
    await act(async () => { await state.submitDraft(); });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.attachments).toEqual([attachments[1]!]);
    expect(sent[0]?.draft).toBe(' [import 12]');
    expect(state.attachments).toEqual([]);
    await act(async () => { expect(undo(h.view())).toBe(false); });
    expect(state.attachments).toEqual([]);
    expect(ref.current!.value).toBe('');
  });
});
