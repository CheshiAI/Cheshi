import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { SettingsApi } from '../shared/settings';
import { product } from '../../config/product.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function withSettings(run: (view: {
  container: HTMLElement; window: Window; projectWrites: number[]; emitLimit(bytes: number): Promise<void>;
}) => Promise<void>, options: {
  projectLoad?: Promise<number>; projectSave?: Promise<void>; failProjectSave?: boolean;
} = {}) {
  const window = new Window();
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Browser storage is unavailable'); } });
  const globals = { window, document: window.document, navigator: window.navigator, Event: window.Event,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
    __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let unmount: (() => Promise<void>) | undefined;
  const projectWrites: number[] = [];
  const projectListeners = new Set<(bytes: number) => void>();
  let projectBytes = 32768;
  const api: SettingsApi = {
    getProjectDocMaxBytes: async () => options.projectLoad ?? projectBytes,
    setProjectDocMaxBytes: async bytes => {
      projectWrites.push(bytes); await options.projectSave;
      if (options.failProjectSave) throw new Error('Could not save');
      projectBytes = bytes;
      for (const listener of projectListeners) listener(bytes);
      return bytes;
    },
    onProjectDocMaxBytesChanged: handler => { projectListeners.add(handler); return () => { projectListeners.delete(handler); }; },
  };
  try {
    const { createRoot } = await import('react-dom/client');
    const { SettingsView } = await import('../frontend/src/features/settings/SettingsView');
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<>
      <SettingsView api={api} />
    </>));
    await run({ container, window, projectWrites,
      emitLimit: async bytes => { await act(async () => { for (const listener of projectListeners) listener(bytes); }); } });
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function button(container: HTMLElement, label: string) {
  const control = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label);
  if (!control) throw new Error(`Missing button ${label}`);
  return control;
}

function category(container: HTMLElement, label: string) {
  const control = [...container.querySelectorAll<HTMLButtonElement>('aside button')].find(item => item.textContent === label);
  if (!control) throw new Error(`Missing category ${label}`);
  return control;
}

test('about displays product metadata and switches back to existing settings', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'About').click());
    expect(category(container, 'About').getAttribute('aria-current')).toBe('page');
    expect(category(container, 'Agents').hasAttribute('aria-current')).toBe(false);
    expect(container.querySelector('#about-heading')?.textContent).toBe(product.displayName.toUpperCase());
    const version = `version v${product.version} · build ${product.buildNumber.padStart(4, '0')}`.toLowerCase();
    expect(container.textContent).toContain(version);
    expect(container.textContent).toContain(`© ${new Date().getFullYear()} ${product.publisher}`);
    const changelog = container.querySelector<HTMLAnchorElement>('a')!;
    expect(changelog.href).toBe('https://github.com/CheshiAI/Cheshi/blob/main/CHANGELOG.md');
    expect(changelog.target).toBe('_blank');
    await act(async () => category(container, 'Appearance').click());
    expect(container.querySelector('#appearance-heading')).not.toBeNull();
    expect(container.querySelector('#about-heading')).toBeNull();
    await act(async () => category(container, 'Agents').click());
    expect(container.querySelector('#project-doc-limit')).not.toBeNull();
    expect(category(container, 'Agents').getAttribute('aria-current')).toBe('page');
  });
});

test('Scheduler category opens the moved settings with the existing settings navigation', async () => {
  await withSettings(async ({ container }) => {
    const item = [...container.querySelectorAll('button')].find(button => button.textContent === 'Scheduler')!;
    expect(item).toBeDefined();
    await act(async () => item.click());
    expect(item.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[aria-labelledby="scheduler-heading"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Automatically run scheduled tasks"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Launch Cheshi at login"]')).not.toBeNull();
    expect(container.querySelector('[aria-labelledby="typesafe-heading"]')).toBeNull();
  });
});


async function enterInstructionLimit(container: HTMLElement, window: Window, value: string) {
  const input = container.querySelector<HTMLInputElement>('#project-doc-limit')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('agent settings load 32 KiB and save 128 KiB through the shared API', async () => {
  await withSettings(async ({ container, window, projectWrites }) => {
    await act(async () => category(container, 'Agents').click());
    expect(category(container, 'Agents').getAttribute('aria-current')).toBe('page');
    expect(container.querySelector<HTMLInputElement>('#project-doc-limit')!.value).toBe('32');
    await enterInstructionLimit(container, window, '128');
    await act(async () => button(container, 'Save instruction size limit').click());
    expect(projectWrites).toEqual([131072]);
    expect(container.querySelector<HTMLInputElement>('#project-doc-limit')!.value).toBe('128');
    expect(container.textContent).toContain('Saved.');
    expect(button(container, 'Save instruction size limit').disabled).toBe(true);
  });
});

test('a settings broadcast takes priority over a stale initial instruction limit', async () => {
  const load = createDeferred<number>();
  await withSettings(async ({ container, emitLimit }) => {
    await act(async () => category(container, 'Agents').click());
    await emitLimit(131072);
    await act(async () => load.resolve(32768));
    expect(container.querySelector<HTMLInputElement>('#project-doc-limit')!.value).toBe('128');
  }, { projectLoad: load.promise });
});

test('a rejected save keeps the prior saved instruction limit and remains retryable', async () => {
  await withSettings(async ({ container, window, projectWrites }) => {
    await act(async () => category(container, 'Agents').click());
    await enterInstructionLimit(container, window, '128');
    await act(async () => button(container, 'Save instruction size limit').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
    expect(button(container, 'Save instruction size limit').disabled).toBe(false);
    expect(projectWrites).toEqual([131072]);
    await act(async () => category(container, 'About').click());
    await act(async () => category(container, 'Agents').click());
    expect(container.querySelector<HTMLInputElement>('#project-doc-limit')!.value).toBe('32');
  }, { failProjectSave: true });
});

test('settings no longer exposes provider credentials or memory recall controls', async () => {
  await withSettings(async ({ container }) => {
    expect(category(container, 'Agents').getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('#history-recall-disclosure')).toBeNull();
    expect(container.textContent).not.toContain('TypeSafe');
    expect(container.textContent).not.toContain('Jev');
  });
});
