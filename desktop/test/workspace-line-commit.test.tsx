import { expect, spyOn, test } from 'bun:test';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useWorkspaceCodeExplanation } from '../frontend/src/features/editor/useWorkspaceCodeExplanation';
import { WorkspaceCodeExplanationMenu } from '../frontend/src/features/editor/WorkspaceCodeExplanationMenu';
import { WorkspaceLineCommitPanel } from '../frontend/src/features/editor/WorkspaceLineCommitPanel';
import { ReviewSidebar } from '../frontend/src/features/shell/ReviewSidebar';
import type { GitLineBlameRequest, GitLineCommit } from '../shared/git-line-blame';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function withDOM(run: (window: Window, container: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const window = new Window();
  const globals = { window, Window: window.Window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try { await run(window, container, root); }
  finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const request: GitLineBlameRequest = { path: 'renamed.ts', line: 3, content: 'unsaved\none\ntwo\n' };
const patch = 'diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ b/old.ts\n@@ -1,2 +1,2 @@\n one\n-before\n+two\n'
  + 'diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-old\n+new\n';
const commit: GitLineCommit = { status: 'committed', blame: { status: 'committed', hash: 'a'.repeat(40),
  author: 'Author', authoredAt: '2026-09-19T00:00:00Z', summary: 'subject', originalPath: 'old.ts', originalLine: 2 },
  message: 'subject\n\n<body>literal reason</body>', messageTruncated: false, patch, truncated: false };

test('right click uses the pointer line while preserving code selection; keyboard and excerpts remain supported', async () => {
  await withDOM(async (window, container, root) => {
    let view: EditorView | null = null;
    let actions!: ReturnType<typeof useWorkspaceCodeExplanation>;
    function Harness({ excerpt = false, path = 'sample.ts' }: { excerpt?: boolean; path?: string }) {
      const ref = useRef<EditorView | null>(null);
      ref.current = view;
      actions = useWorkspaceCodeExplanation({ active: true, path, firstLine: excerpt ? 100 : 1,
        lineEnding: excerpt ? null : 'crlf', editorViewRef: ref });
      return <div data-editor-host {...actions.hostHandlers} />;
    }
    await act(async () => root.render(<Harness />));
    const host = container.querySelector<HTMLElement>('[data-editor-host]')!;
    view = new EditorView({ parent: host, state: EditorState.create({ doc: 'first\nsecond', selection: { anchor: 0, head: 5 } }) });
    const position = spyOn(view, 'posAtCoords').mockReturnValue(7);
    const coordinates = spyOn(view, 'coordsAtPos').mockReturnValue({ left: 0, right: 10, top: 0, bottom: 10 });
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => view!.contentDOM.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }) as unknown as MouseEvent));
      expect(actions.menu?.lineRequest).toEqual({ path: 'sample.ts', line: 2, content: 'first\r\nsecond' });
      expect(actions.menu?.selection?.selectedText).toBe('first');
      expect(view.state.selection.main.from).toBe(0);
      expect(view.state.selection.main.to).toBe(5);
      const opened: GitLineBlameRequest[] = [];
      await act(async () => actions.showLineCommit(value => opened.push(value)));
      expect(opened[0]?.line).toBe(2);
      expect(actions.menu).toBeNull();
      await act(async () => root.render(<Harness path="different.ts" />));
      expect(actions.menu).toBeNull();
      view.dispatch({ selection: { anchor: 7 } });
      await act(async () => view!.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }) as unknown as KeyboardEvent));
      expect(actions.menu?.lineRequest?.line).toBe(2);
      expect(actions.menu?.selection).toBeNull();
      await act(async () => root.render(<Harness excerpt />));
      view.dispatch({ selection: { anchor: 0, head: 5 } });
      await act(async () => view!.contentDOM.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }) as unknown as MouseEvent));
      expect(actions.menu?.lineRequest).toBeNull();
      expect(actions.menu?.selection?.startLine).toBe(100);
    } finally { position.mockRestore(); coordinates.mockRestore(); view.destroy(); }
  });
});

test('context menu enables line details without a selection and retains explain for selected code', async () => {
  await withDOM(async (_window, _container, root) => {
    let opens = 0;
    await act(async () => root.render(<WorkspaceCodeExplanationMenu target={{ x: 20, y: 20, lineRequest: request, selection: null, error: null }}
      onClose={() => {}} onExplain={() => {}} onShowLineCommit={() => { opens++; }} />));
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));
    expect(buttons.map(button => [button.textContent, button.disabled])).toEqual([['Show line commit', false], ['Explain code', true]]);
    await act(async () => buttons[0]!.click());
    expect(opens).toBe(1);
  });
});

test('details show only the historical file, highlight its line, and render messages literally', async () => {
  await withDOM(async (_window, _container, root) => {
    const read = async () => commit;
    await act(async () => root.render(<WorkspaceLineCommitPanel request={request} onClose={() => {}} read={read} />));
    expect(document.querySelector('[aria-label="Line commit"]')?.textContent).toContain('<body>literal reason</body>');
    expect(document.querySelector('[aria-label="Line commit"] body')).toBeNull();
    expect(document.querySelector('dialog, [aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-line-target=true]')?.textContent).toContain('two');
    expect(document.querySelector('[role=table]')?.getAttribute('aria-label')).toBe('Diff for old.ts');
    const sibling = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'other.ts');
    expect(sibling).toBeUndefined();
    expect(document.querySelector('[aria-label="Line commit"]')?.textContent).not.toContain('other.ts');
    expect(document.querySelector('nav')).toBeNull();
    expect(document.querySelector('[aria-label^="Open file in editor"]')).toBeNull();
  });
});

test('the side panel leaves the editor interactive and closes only through its own controls', async () => {
  await withDOM(async (window, _container, root) => {
    let closes = 0;
    const read = async () => commit;
    await act(async () => root.render(<>
      <input aria-label="Editor input" defaultValue="draft" />
      <WorkspaceLineCommitPanel request={request} onClose={() => { closes++; }} read={read} />
    </>));
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    input.value = 'edited draft';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('edited draft');
    expect(closes).toBe(0);
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close line commit"]')!;
    await act(async () => close.click());
    expect(closes).toBe(1);
    await act(async () => close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent));
    expect(closes).toBe(2);
  });
});

test('closing and reopening retains the side panel for transitions without blocking the chat list', async () => {
  await withDOM(async (_window, _container, root) => {
    const render = (lineCommit: GitLineBlameRequest | null) => <>
      <aside aria-label="Left chats"><button>Chat list</button></aside>
      <ReviewSidebar open item={null} initialPath={null} lineCommit={lineCommit} onCloseReview={() => {}} />
    </>;
    await act(async () => root.render(render(request)));
    const panel = document.querySelector('[aria-label="Line commit"]');
    expect(panel).not.toBeNull();
    expect(document.querySelector('[aria-label="Right sidebar"]')).toBeNull();
    const chats = document.querySelector('[aria-label="Left chats"]');
    expect(chats?.hasAttribute('inert')).toBe(false);
    await act(async () => root.render(render(null)));
    expect(document.querySelector('[aria-label="Line commit"]')).toBe(panel);
    expect(document.querySelector('[aria-label="Review sidebar"]')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[aria-label="Left chats"]')).toBe(chats);
    expect(chats?.hasAttribute('inert')).toBe(false);
    await act(async () => root.render(render(request)));
    expect(document.querySelector('[aria-label="Line commit"]')).toBe(panel);
    expect(document.querySelector('[aria-label="Review sidebar"]')?.hasAttribute('inert')).toBe(false);
  });
});

test('late responses never replace a newer line result; uncommitted and error states show no diff', async () => {
  await withDOM(async (_window, _container, root) => {
    const old = createDeferred<GitLineCommit>();
    const read = async (value: GitLineBlameRequest): Promise<GitLineCommit> => value.line === 3 ? old.promise : { status: 'uncommitted' };
    await act(async () => root.render(<WorkspaceLineCommitPanel request={request} onClose={() => {}} read={read} />));
    await act(async () => root.render(<WorkspaceLineCommitPanel request={{ ...request, line: 1 }} onClose={() => {}} read={read} />));
    await act(async () => old.resolve(commit));
    expect(document.querySelector('[aria-label="Line commit"]')?.textContent).toContain('has not been committed');
    expect(document.querySelector('[role=table]')).toBeNull();
    await act(async () => root.render(<WorkspaceLineCommitPanel request={request} onClose={() => {}}
      read={async () => { throw new Error('Commit unavailable'); }} />));
    expect(document.querySelector('[role=alert]')?.textContent).toBe('Commit unavailable');
    expect(document.querySelector('[role=table]')).toBeNull();
  });
});

for (const panelName of ['line commit', 'local history'] as const) {
test(`${panelName} resizing clamps both panes, cancels safely, and retains the preferred width across toggles and window resizing`, async () => {
  await withDOM(async (window, container, root) => {
    let layoutWidth = 1400;
    let notifyResize = () => {};
    class TestResizeObserver {
      constructor(callback: () => void) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
    const geometry = spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const available = layoutWidth - 320;
      const ratio = Number(this.style.getPropertyValue('--review-ratio')) || 0.5;
      const [left, width] = this.className === 'app-layout' ? [0, layoutWidth]
        : this.className === 'workspace-column' ? [320, available * (1 - ratio)]
          : [layoutWidth - available * ratio, available * ratio];
      return new window.DOMRect(left, 0, width, 800);
    });
    const render = (open = true, lineCommit: GitLineBlameRequest | null = request) => <div className="app-layout">
      <div className="workspace-column" />
      <ReviewSidebar open={open} item={null} initialPath={null}
        lineCommit={panelName === 'line commit' ? lineCommit : null}
        localHistoryPath={panelName === 'local history' && lineCommit ? lineCommit.path : null}
        onCloseReview={() => {}} />
    </div>;
    try {
      await act(async () => root.render(render()));
      const slot = container.querySelector<HTMLElement>('[aria-label="Review sidebar"]')!;
      const ratio = () => Number(slot.style.getPropertyValue('--review-ratio'));
      const handle = () => container.querySelector<HTMLElement>('[role="separator"]')!;
      const capture: { pointerId: number | null } = { pointerId: null };
      const pointer = async (type: string, x: number, pointerId = 1, button = 0) => {
        const target = handle();
        target.setPointerCapture = id => { capture.pointerId = id; };
        target.hasPointerCapture = id => capture.pointerId === id;
        target.releasePointerCapture = () => { capture.pointerId = null; };
        await act(async () => target.dispatchEvent(new window.PointerEvent(type,
          { clientX: x, pointerId, button, bubbles: true, cancelable: true }) as unknown as PointerEvent));
      };
      const key = async (value: string) => {
        await act(async () => handle().dispatchEvent(new window.KeyboardEvent('keydown',
          { key: value, bubbles: true, cancelable: true }) as unknown as KeyboardEvent));
      };
      expect(ratio()).toBe(0.5);
      expect(handle().getAttribute('aria-label')).toBe(`Resize ${panelName} panel`);
      await pointer('pointerdown', 860, 1, 2);
      expect(capture.pointerId).toBeNull();
      await pointer('pointerdown', 860);
      expect(capture.pointerId).toBe(1);
      expect(slot.dataset.resizing).toBe('true');
      await pointer('pointermove', 760, 2);
      expect(ratio()).toBe(0.5);
      await pointer('pointermove', 760);
      expect(ratio()).toBeCloseTo(640 / 1080);
      await pointer('pointerup', 760);
      expect(capture.pointerId).toBeNull();
      expect(slot.dataset.resizing).toBeUndefined();
      const preferred = ratio();

      await act(async () => root.render(render(false)));
      expect(handle()).toBeNull();
      expect(slot.hasAttribute('inert')).toBe(true);
      await act(async () => root.render(render()));
      expect(ratio()).toBe(preferred);
      await act(async () => root.render(render(true, null)));
      expect(handle()).toBeNull();
      await act(async () => root.render(render()));
      expect(ratio()).toBe(preferred);

      for (const cancelEvent of ['pointercancel', 'lostpointercapture']) {
        await pointer('pointerdown', 760);
        await pointer('pointermove', -1000);
        expect(ratio() * 1080).toBeCloseTo(760);
        await pointer(cancelEvent, -1000);
        expect(ratio()).toBe(preferred);
        expect(slot.dataset.resizing).toBeUndefined();
      }
      layoutWidth = 820;
      await act(async () => notifyResize());
      expect(ratio()).toBe(0.5);
      layoutWidth = 1400;
      await act(async () => notifyResize());
      expect(ratio()).toBe(preferred);
      await key('Home');
      expect(ratio() * 1080).toBeCloseTo(320);
      await key('End');
      expect((1 - ratio()) * 1080).toBeCloseTo(320);
      await key('ArrowRight');
      expect(ratio()).toBeCloseTo(760 / 1080 - 0.05);
      await key('ArrowLeft');
      expect(ratio()).toBeCloseTo(760 / 1080);
      await pointer('pointerdown', 640);
      await pointer('pointermove', 3000);
      expect(ratio() * 1080).toBeCloseTo(320);
      await pointer('pointerup', 3000);
      await act(async () => handle().dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }) as unknown as MouseEvent));
      expect(ratio()).toBe(0.5);
    } finally { geometry.mockRestore(); }
  });
});
}
