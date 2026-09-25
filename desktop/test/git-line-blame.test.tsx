import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { GitLineBlameRequest } from '../frontend/src/features/editor/gitLineBlameRequest';
import { gitLineBlame } from '../frontend/src/features/editor/gitLineBlame';
import { attachGitLineBlameTooltip } from '../frontend/src/features/editor/gitLineBlameTooltip';
import type { GitLineBlame, GitLineBlameRequest as Request } from '../shared/git-line-blame';

const tick = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('debounces selected-line changes, serializes requests, and drops stale results', async () => {
  const calls: number[] = [];
  const results: number[] = [];
  const pending = [createDeferred<GitLineBlame>(), createDeferred<GitLineBlame>()];
  const controller = new GitLineBlameRequest(line => {
    calls.push(line);
    return pending[calls.length - 1]!.promise;
  }, line => results.push(line), 5);
  controller.select(1);
  controller.select(2);
  controller.select(3);
  await tick();
  expect(calls).toEqual([3]);
  controller.select(4);
  await tick();
  expect(calls).toEqual([3]);
  pending[0]!.resolve({ status: 'uncommitted' });
  await tick();
  expect(calls).toEqual([3, 4]);
  expect(results).toEqual([]);
  pending[1]!.resolve({ status: 'uncommitted' });
  await tick();
  expect(results).toEqual([4]);
  controller.select(4);
  await tick();
  expect(calls).toHaveLength(2);
  controller.reset();
});

test('reset on editing or destruction cancels pending work and ignores in-flight responses', async () => {
  const pending = createDeferred<GitLineBlame>();
  const results: GitLineBlame[] = [];
  let calls = 0;
  const controller = new GitLineBlameRequest(async () => { calls++; return pending.promise; }, (_line, result) => results.push(result), 5);
  controller.select(1);
  controller.reset();
  await tick();
  expect(calls).toBe(0);
  controller.select(2);
  await tick();
  controller.reset();
  pending.resolve({ status: 'uncommitted' });
  await tick();
  expect(results).toEqual([]);
});

test('failed history requests are unavailable, never uncommitted', async () => {
  const results: GitLineBlame[] = [];
  const controller = new GitLineBlameRequest(async () => { throw new Error('Git failed'); }, (_line, result) => results.push(result), 5);
  controller.select(1);
  await tick();
  expect(results).toEqual([{ status: 'unavailable' }]);
  controller.reset();
});

test('blame tooltip stays on screen, allows hovering its contents, and cleans up on dismissal', async () => {
  const window = new Window();
  window.innerWidth = 800;
  window.innerHeight = 600;
  const anchor = window.document.createElement('span');
  window.document.body.append(anchor);
  const bounds = spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this === anchor ? new window.DOMRect(760, 550, 100, 20) : new window.DOMRect(0, 0, 600, 160);
  });
  const cleanup = attachGitLineBlameTooltip(anchor as unknown as HTMLElement, {
    status: 'committed', hash: 'b'.repeat(40), author: 'Author', authoredAt: '2026-09-19T00:00:00.000Z',
    summary: 'A longer commit message', originalLine: 1, originalPath: 'sample.txt',
  });
  const card = () => window.document.querySelector('.git-line-blame-tooltip-anchor');
  const enter = () => anchor.dispatchEvent(new window.PointerEvent('pointerenter', { pointerType: 'mouse' }));
  try {
    enter();
    anchor.dispatchEvent(new window.PointerEvent('pointerleave'));
    await tick(300);
    expect(card()).toBeNull();
    enter();
    await tick(280);
    expect(card()?.getAttribute('style')).toContain('left: 192px');
    expect(card()?.getAttribute('style')).toContain('top: 382px');
    anchor.dispatchEvent(new window.PointerEvent('pointerleave'));
    card()!.dispatchEvent(new window.PointerEvent('pointerenter'));
    await tick(150);
    expect(card()).not.toBeNull();
    card()!.dispatchEvent(new window.PointerEvent('pointerleave'));
    await tick(150);
    expect(card()).toBeNull();
    anchor.dispatchEvent(new window.FocusEvent('focus'));
    window.document.querySelector('[role="tooltip"]')!.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    expect(card()).not.toBeNull();
    window.dispatchEvent(new window.Event('resize'));
    expect(card()).toBeNull();
    anchor.dispatchEvent(new window.FocusEvent('focus'));
    anchor.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    expect(card()).toBeNull();
    enter();
    cleanup();
    await tick(280);
    expect(card()).toBeNull();
    expect(anchor.hasAttribute('aria-describedby')).toBe(false);
  } finally {
    cleanup();
    bounds.mockRestore();
    await window.happyDOM.close();
  }
});

test('selected-line history ignores pointer movement and refreshes on selection, editing and reopen', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    MutationObserver: window.MutationObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const calls: Request[] = [];
  const content = 'alpha\nbeta\n';
  let view: EditorView | undefined;
  try {
    view = new EditorView({ parent: container as unknown as HTMLElement, state: EditorState.create({ doc: content,
      extensions: [gitLineBlame({ path: 'sample.txt', lineEnding: 'crlf', read: async request => {
        calls.push(request);
        return { status: 'committed', hash: 'a'.repeat(40), author: 'Author', authoredAt: '2026-09-19T00:00:00.000Z',
          summary: '<script>literal summary</script>', originalLine: 1, originalPath: 'sample.txt' };
      } })],
    }) });
    await tick(350);
    expect(calls).toEqual([{ path: 'sample.txt', line: 1, content: 'alpha\r\nbeta\r\n' }]);
    expect(container.querySelector('.cm-git-line-blame')?.textContent).toContain('<script>literal summary</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(view.state.doc.toString()).toBe(content);
    // A pointer over beta must neither select it nor request its history.
    const position = spyOn(view, 'posAtCoords').mockReturnValue(7);
    view.contentDOM.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as unknown as MouseEvent);
    view.contentDOM.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }) as unknown as MouseEvent);
    await tick(350);
    expect(calls).toHaveLength(1);
    expect(position).not.toHaveBeenCalled();
    expect(container.querySelector('.cm-git-line-blame')?.parentElement?.textContent).toStartWith('alpha');
    view.dispatch({ selection: { anchor: 7 } });
    expect(container.querySelector('.cm-git-line-blame')).toBeNull();
    await tick(350);
    expect(calls.at(-1)?.line).toBe(2);
    expect(container.querySelector('.cm-git-line-blame')?.parentElement?.textContent).toStartWith('beta');
    view.dispatch({ selection: { anchor: 8 } });
    await tick(350);
    expect(calls).toHaveLength(2);

    const trigger = container.querySelector<HTMLElement>('.cm-git-line-blame')!;
    expect(trigger.hasAttribute('title')).toBe(false);
    trigger.dispatchEvent(new window.FocusEvent('focus'));
    const tooltip = window.document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain('LAST CHANGE');
    expect(tooltip.querySelector('code')?.textContent).toBe('aaaaaaaa');
    expect(tooltip.textContent).toContain('<script>literal summary</script>');
    expect(tooltip.querySelector('script')).toBeNull();
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(window.document.querySelector('[role="tooltip"]')).toBeNull();
    trigger.dispatchEvent(new window.FocusEvent('focus'));
    view.dispatch({ changes: { from: 0, insert: 'new\n' } });
    expect(container.querySelector('.cm-git-line-blame')).toBeNull();
    expect(window.document.querySelector('[role="tooltip"]')).toBeNull();
    await tick(350);
    expect(calls.at(-1)?.line).toBe(3);
    expect(calls.at(-1)?.content).toBe('new\r\nalpha\r\nbeta\r\n');
    expect(container.querySelector('.cm-git-line-blame')).not.toBeNull();
    const state = view.state;
    position.mockRestore();
    view.destroy();
    view = new EditorView({ parent: container as unknown as HTMLElement, state });
    expect(container.querySelector('.cm-git-line-blame')).toBeNull();
    await tick(350);
    expect(calls.at(-1)?.line).toBe(3);
    expect(container.querySelector('.cm-git-line-blame')).not.toBeNull();
  } finally {
    view?.destroy();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
