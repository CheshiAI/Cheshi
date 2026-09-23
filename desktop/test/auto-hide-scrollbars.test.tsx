import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useAutoHideScrollbars } from '../frontend/src/shared/useAutoHideScrollbars';
import { workspaceEditorScrollbars } from '../frontend/src/features/editor/workspaceEditorScrollbars';

function Fixture({ visible, revision }: { visible: boolean; revision: number }) {
  const surface = useAutoHideScrollbars<HTMLElement>();
  return visible ? <aside ref={surface} data-revision={revision}>
    <div data-list="files"><span>File</span></div>
    <div data-list="chats"><span>Chat</span></div>
  </aside> : null;
}

async function withScrollbars(run: (h: {
  container: HTMLElement;
  render(visible?: boolean, revision?: number): Promise<void>;
  scroll(target: HTMLElement): void;
  hoverContent(target: HTMLElement): void;
  advance(ms: number): void;
  pending(): number;
}) => Promise<void>) {
  const window = new Window();
  const globals = {
    window, Window: window.Window, document: window.document, navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const timerMethods = new Map(['setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(window, key)]));
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let nextId = 0;
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: (callback: () => void, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, callback });
    return id;
  } });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id: number) => { timers.delete(id); } });
  try {
    await run({
      container,
      render: async (visible = true, revision = 0) => { await act(async () => root.render(<Fixture visible={visible} revision={revision} />)); },
      scroll: target => { target.dispatchEvent(new window.Event('scroll') as unknown as Event); },
      hoverContent: target => { target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }) as unknown as MouseEvent); },
      pending: () => timers.size,
      advance: ms => {
        const end = now + ms;
        for (;;) {
          const next = [...timers].sort(([, left], [, right]) => left.at - right.at)[0];
          if (!next || next[1].at > end) break;
          timers.delete(next[0]);
          now = next[1].at;
          next[1].callback();
        }
        now = end;
      },
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of timerMethods) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('sidebar scrollbars start hidden and enter fade-out after scrolling stops, even with the pointer over content', async () => {
  await withScrollbars(async ({ container, render, scroll, hoverContent, advance, pending }) => {
    await render();
    const surface = container.querySelector('aside')!;
    const list = container.querySelector<HTMLElement>('[data-list="chats"]')!;
    expect(surface.hasAttribute('data-auto-hide-scrollbars')).toBe(true);
    expect(list.hasAttribute('data-scrollbar-active')).toBe(false);
    hoverContent(list.firstElementChild as HTMLElement);
    expect(list.hasAttribute('data-scrollbar-active')).toBe(false);
    scroll(list);
    expect(list.getAttribute('data-scrollbar-active')).toBe('true');
    advance(699);
    expect(list.getAttribute('data-scrollbar-active')).toBe('true');
    advance(1);
    expect(list.getAttribute('data-scrollbar-active')).toBe('false');
    expect(pending()).toBe(0);
  });
});

test('scroll activity renews the idle deadline for each list without a render resetting it', async () => {
  await withScrollbars(async ({ container, render, scroll, advance, pending }) => {
    await render();
    const files = container.querySelector<HTMLElement>('[data-list="files"]')!;
    const chats = container.querySelector<HTMLElement>('[data-list="chats"]')!;
    scroll(files);
    advance(400);
    scroll(files);
    advance(100);
    scroll(chats);
    await render(true, 1);
    expect(pending()).toBe(2);
    advance(300);
    expect(files.getAttribute('data-scrollbar-active')).toBe('true');
    expect(chats.getAttribute('data-scrollbar-active')).toBe('true');
    advance(300);
    expect(files.getAttribute('data-scrollbar-active')).toBe('false');
    expect(chats.getAttribute('data-scrollbar-active')).toBe('true');
    advance(100);
    expect(chats.getAttribute('data-scrollbar-active')).toBe('false');
    expect(pending()).toBe(0);
  });
});

test('scrolling during fade-out restores visibility and starts a new idle deadline', async () => {
  await withScrollbars(async ({ container, render, scroll, advance, pending }) => {
    await render();
    const list = container.querySelector<HTMLElement>('[data-list="chats"]')!;
    scroll(list);
    advance(700);
    expect(list.getAttribute('data-scrollbar-active')).toBe('false');
    advance(120);
    scroll(list);
    expect(list.getAttribute('data-scrollbar-active')).toBe('true');
    advance(699);
    expect(list.getAttribute('data-scrollbar-active')).toBe('true');
    expect(pending()).toBe(1);
    advance(1);
    expect(list.getAttribute('data-scrollbar-active')).toBe('false');
    expect(pending()).toBe(0);
  });
});

test('detaching the sidebar clears timers and listeners, and remounting starts hidden', async () => {
  await withScrollbars(async ({ container, render, scroll, advance, pending }) => {
    await render();
    const surface = container.querySelector('aside')!;
    const list = container.querySelector<HTMLElement>('[data-list="files"]')!;
    const chats = container.querySelector<HTMLElement>('[data-list="chats"]')!;
    scroll(chats);
    advance(700);
    expect(chats.getAttribute('data-scrollbar-active')).toBe('false');
    scroll(list);
    expect(pending()).toBe(1);
    await render(false);
    expect(pending()).toBe(0);
    expect(surface.hasAttribute('data-auto-hide-scrollbars')).toBe(false);
    expect(list.hasAttribute('data-scrollbar-active')).toBe(false);
    expect(chats.hasAttribute('data-scrollbar-active')).toBe(false);
    scroll(list);
    expect(pending()).toBe(0);
    await render();
    const next = container.querySelector<HTMLElement>('[data-list="files"]')!;
    expect(next).not.toBe(list);
    expect(next.hasAttribute('data-scrollbar-active')).toBe(false);
    scroll(next);
    expect(next.getAttribute('data-scrollbar-active')).toBe('true');
    advance(700);
    expect(next.getAttribute('data-scrollbar-active')).toBe('false');
  });
});

test.each([false, true])('editor scrollbars handle both axes and restored tabs (readOnly=%s)', async readOnly => {
  await withScrollbars(async ({ scroll, advance, pending }) => {
    const host = document.createElement('div');
    document.body.append(host);
    let editor = new EditorView({ parent: host, state: EditorState.create({
      doc: 'line one\nline two',
      extensions: [workspaceEditorScrollbars, EditorState.readOnly.of(readOnly)],
    }) });
    try {
      const first = editor.scrollDOM;
      expect(first.hasAttribute('data-auto-hide-scrollbars')).toBe(true);
      expect(first.hasAttribute('data-scrollbar-active')).toBe(false);
      first.scrollLeft = 80;
      scroll(first);
      expect(first.getAttribute('data-scrollbar-active')).toBe('true');
      advance(400);
      first.scrollTop = 120;
      scroll(first);
      advance(699);
      expect(first.getAttribute('data-scrollbar-active')).toBe('true');
      advance(1);
      expect(first.getAttribute('data-scrollbar-active')).toBe('false');
      expect(first.scrollLeft).toBe(80);
      expect(first.scrollTop).toBe(120);

      const state = editor.state;
      editor.destroy();
      expect(first.hasAttribute('data-auto-hide-scrollbars')).toBe(false);
      expect(first.hasAttribute('data-scrollbar-active')).toBe(false);
      editor = new EditorView({ parent: host, state });
      expect(editor.scrollDOM.hasAttribute('data-auto-hide-scrollbars')).toBe(true);
      expect(editor.scrollDOM.hasAttribute('data-scrollbar-active')).toBe(false);
      scroll(editor.scrollDOM);
      expect(editor.scrollDOM.getAttribute('data-scrollbar-active')).toBe('true');
    } finally {
      editor.destroy();
      host.remove();
    }
    expect(pending()).toBe(0);
    scroll(editor.scrollDOM);
    advance(1000);
    expect(editor.scrollDOM.hasAttribute('data-scrollbar-active')).toBe(false);
  });
});
