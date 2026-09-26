import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createRef } from 'react';
import type { EditorSearchControls } from '../frontend/src/features/editor/codeEditorSearch';

async function withSearchPanel(run: (view: {
  container: HTMLElement;
  window: Window;
  inputRef: ReturnType<typeof createRef<HTMLInputElement>>;
  actions: string[];
  setValid(valid: boolean): Promise<void>;
  flushFrames(): void;
}) => Promise<void>) {
  const window = new Window();
  const frames: FrameRequestCallback[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    Event: window.Event, KeyboardEvent: window.KeyboardEvent,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { WorkspaceEditorSearchPanel } = await import('../frontend/src/features/editor/WorkspaceEditorSearchPanel');
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); };
    const inputRef = createRef<HTMLInputElement>();
    const actions: string[] = [];
    let controls: EditorSearchControls = {
      search: 'needle', replace: 'replacement', caseSensitive: false, regexp: false, wholeWord: false,
    };
    let queryValid = true;
    const render = () => root.render(<WorkspaceEditorSearchPanel controls={controls} inputRef={inputRef}
      queryValid={queryValid} onChange={update => { controls = { ...controls, ...update }; render(); }}
      onNext={() => actions.push('next')} onPrevious={() => actions.push('previous')}
      onSelectAll={() => actions.push('all')} onReplace={() => actions.push('replace')}
      onReplaceAll={() => actions.push('replace-all')} onClose={() => actions.push('close')} />);
    await act(async () => render());
    await run({ container, window, inputRef, actions,
      setValid: async valid => { queryValid = valid; await act(async () => render()); },
      flushFrames: () => { for (const callback of frames.splice(0)) callback(0); },
    });
  } finally {
    await unmount?.();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(control => (
    control.getAttribute('aria-label') === label || control.textContent?.trim() === label
  ));
  assert.ok(result, `Missing button ${label}`);
  return result;
}

test('search fields retain keyboard navigation, close shortcuts and the forwarded input ref', async () => {
  await withSearchPanel(async ({ container, inputRef, actions, setValid }) => {
    const find = container.querySelector<HTMLInputElement>('input[name="search"]');
    const replace = container.querySelector<HTMLInputElement>('input[name="replace"]');
    assert.ok(find && replace);
    expect(inputRef.current).toBe(find);
    for (const [field, key, shiftKey] of [
      [find, 'Enter', false], [find, 'Enter', true], [find, 'Escape', false], [replace, 'Escape', false],
    ] as const) {
      const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
      await act(async () => { field.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(actions).toEqual(['next', 'previous', 'close', 'close']);
    await setValid(false);
    await act(async () => { find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(actions).toHaveLength(4);
  });
});

test('option buttons preserve pressed states and invalid queries disable search commands', async () => {
  await withSearchPanel(async ({ container, actions, setValid }) => {
    for (const label of ['Match case', 'Match whole word', 'Use regular expression']) {
      const option = button(container, label);
      expect(option.getAttribute('aria-pressed')).toBe('false');
      await act(async () => option.click());
      expect(option.getAttribute('aria-pressed')).toBe('true');
      await act(async () => option.click());
      expect(option.getAttribute('aria-pressed')).toBe('false');
    }
    const commands = ['Previous match', 'Next match', 'Select all matches', 'Replace', 'Replace all'];
    for (const label of commands) await act(async () => button(container, label).click());
    expect(actions).toEqual(['previous', 'next', 'all', 'replace', 'replace-all']);
    await setValid(false);
    for (const label of commands) {
      const command = button(container, label);
      expect(command.disabled).toBe(true);
      await act(async () => command.click());
    }
    expect(actions).toHaveLength(5);
    await act(async () => button(container, 'Close find and replace').click());
    expect(actions.at(-1)).toBe('close');
  });
});

test('standard fields keep controlled input updates and clearing restores find focus', async () => {
  await withSearchPanel(async ({ container, window, inputRef, flushFrames }) => {
    const find = container.querySelector<HTMLInputElement>('input[name="search"]');
    const replace = container.querySelector<HTMLInputElement>('input[name="replace"]');
    assert.ok(find && replace);
    for (const [field, value] of [[find, 'updated query'], [replace, 'updated replacement']] as const) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(field.value).toBe(value);
    }
    const clear = button(container, 'Clear find text');
    await act(async () => { clear.focus(); clear.click(); });
    flushFrames();
    expect(find.value).toBe('');
    expect(replace.value).toBe('updated replacement');
    expect(container.querySelector('[aria-label="Clear find text"]')).toBeNull();
    expect(globalThis.document.activeElement).toBe(inputRef.current);
  });
});
