import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { GitLineBlameRequest } from '../frontend/src/features/editor/gitLineBlameRequest';
import { gitLineBlame } from '../frontend/src/features/editor/gitLineBlame';
import type { GitLineBlame, GitLineBlameRequest as Request } from '../shared/git-line-blame';

const tick = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('debounces movement, serializes requests, and drops stale results', async () => {
  const calls: number[] = [];
  const results: number[] = [];
  const pending = [createDeferred<GitLineBlame>(), createDeferred<GitLineBlame>()];
  const controller = new GitLineBlameRequest(line => {
    calls.push(line);
    return pending[calls.length - 1]!.promise;
  }, line => results.push(line), 5);
  controller.hover(1);
  controller.hover(2);
  controller.hover(3);
  await tick();
  expect(calls).toEqual([3]);
  controller.hover(4);
  await tick();
  expect(calls).toEqual([3]);
  pending[0]!.resolve({ status: 'uncommitted' });
  await tick();
  expect(calls).toEqual([3, 4]);
  expect(results).toEqual([]);
  pending[1]!.resolve({ status: 'uncommitted' });
  await tick();
  expect(results).toEqual([4]);
  controller.hover(4);
  await tick();
  expect(calls).toHaveLength(2);
  controller.reset();
});

test('reset on editing, leaving, or destruction cancels pending work and ignores in-flight responses', async () => {
  const pending = createDeferred<GitLineBlame>();
  const results: GitLineBlame[] = [];
  let calls = 0;
  const controller = new GitLineBlameRequest(async () => { calls++; return pending.promise; }, (_line, result) => results.push(result), 5);
  controller.hover(1);
  controller.reset();
  await tick();
  expect(calls).toBe(0);
  controller.hover(2);
  await tick();
  controller.reset();
  pending.resolve({ status: 'uncommitted' });
  await tick();
  expect(results).toEqual([]);
});

test('failed history requests are unavailable, never uncommitted', async () => {
  const results: GitLineBlame[] = [];
  const controller = new GitLineBlameRequest(async () => { throw new Error('Git failed'); }, (_line, result) => results.push(result), 5);
  controller.hover(1);
  await tick();
  expect(results).toEqual([{ status: 'unavailable' }]);
  controller.reset();
});

test('hover renders literal commit metadata without changing editor text and clears on edit and reopen', async () => {
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
    // Happy DOM has no layout; supply only the hit-test coordinate result.
    const position = spyOn(view, 'posAtCoords').mockReturnValue(1);
    view.contentDOM.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as unknown as MouseEvent);
    await tick(350);
    expect(calls).toEqual([{ path: 'sample.txt', line: 1, content: 'alpha\r\nbeta\r\n' }]);
    expect(container.querySelector('.cm-git-line-blame')?.textContent).toContain('<script>literal summary</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(view.state.doc.toString()).toBe(content);
    view.dispatch({ changes: { from: 0, insert: 'new\n' } });
    expect(container.querySelector('.cm-git-line-blame')).toBeNull();
    view.contentDOM.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as unknown as MouseEvent);
    await tick(350);
    expect(container.querySelector('.cm-git-line-blame')).not.toBeNull();
    const state = view.state;
    position.mockRestore();
    view.destroy();
    view = new EditorView({ parent: container as unknown as HTMLElement, state });
    expect(container.querySelector('.cm-git-line-blame')).toBeNull();
  } finally {
    view?.destroy();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
