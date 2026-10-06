import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { SettingsApi, TypeSafeSettings } from '../shared/settings';
import { product } from '../../config/product.mts';

const none: TypeSafeSettings = { source: 'none', maskedKey: null, canSave: true, error: null, historyRecallEnabled: false };
const saved: TypeSafeSettings = { source: 'saved', maskedKey: '••••2345', canSave: true, error: null, historyRecallEnabled: false };
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function withSettings(run: (view: {
  container: HTMLElement; window: Window; projectWrites: number[]; emitLimit(bytes: number): Promise<void>; savedKeys: string[]; checks: () => number; recallWrites: boolean[];
  emit(state: TypeSafeSettings): Promise<void>; initial: ReturnType<typeof createDeferred<TypeSafeSettings>>;
}) => Promise<void>, options: {
  projectLoad?: Promise<number>; projectSave?: Promise<void>; failProjectSave?: boolean;
  failRecallSave?: boolean; recallSave?: Promise<void>; check?: () => Promise<boolean>;
  removeReply?: () => Promise<TypeSafeSettings>; broadcast?: boolean;
} = {}) {
  const window = new Window();
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Browser storage is unavailable'); } });
  const globals = { window, document: window.document, navigator: window.navigator, Event: window.Event,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
    __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let unmount: (() => Promise<void>) | undefined;
  const listeners = new Set<(state: TypeSafeSettings) => void>();
  let current = none;
  const publish = (state: TypeSafeSettings, broadcast = options.broadcast !== false) => {
    current = state;
    if (broadcast) for (const listener of listeners) listener(state);
  };
  const initial = createDeferred<TypeSafeSettings>();
  const savedKeys: string[] = [];
  const recallWrites: boolean[] = [];
  let checks = 0;
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
    getTypeSafe: async () => { const state = await initial.promise; current = state; return state; },
    saveTypeSafe: async key => { savedKeys.push(key); publish(saved); return saved; },
    removeTypeSafe: async () => {
      if (options.removeReply) return options.removeReply();
      const state = { ...none, historyRecallEnabled: current.historyRecallEnabled }; publish(state); return state;
    },
    checkTypeSafe: async () => { checks++; return options.check ? options.check() : true; },
    setHistoryRecallEnabled: async visible => {
      recallWrites.push(visible);
      await options.recallSave;
      if (options.failRecallSave) throw new Error('Could not save the history recall setting. Try again.');
      const state = { ...current, historyRecallEnabled: visible };
      publish(state);
      return state;
    },
    onTypeSafeChanged(handler) { listeners.add(handler); return () => { listeners.delete(handler); }; },
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
    await run({ container, window, savedKeys, projectWrites,
      emitLimit: async bytes => { await act(async () => { for (const listener of projectListeners) listener(bytes); }); }, checks: () => checks, recallWrites, initial,
      emit: async state => { await act(async () => publish(state, true)); } });
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
  await withSettings(async ({ container, initial }) => {
    await act(async () => initial.resolve(none));
    await act(async () => category(container, 'About').click());
    expect(category(container, 'About').getAttribute('aria-current')).toBe('page');
    expect(category(container, 'TypeSafe API').hasAttribute('aria-current')).toBe(false);
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
    await act(async () => category(container, 'TypeSafe API').click());
    expect(container.querySelector('input')?.type).toBe('password');
    expect(category(container, 'TypeSafe API').getAttribute('aria-current')).toBe('page');
  });
});

test('settings saves a password, clears it, verifies the connection and deletes the saved key', async () => {
  await withSettings(async ({ container, window, initial, savedKeys, checks }) => {
    await act(async () => initial.resolve(none));
    expect(container.querySelector('aside')?.textContent).toContain('TypeSafe API');
    const input = container.querySelector('input')!;
    expect(input.type).toBe('password');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'fixture-key-12345');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(container, 'Save key').disabled).toBe(false);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(savedKeys).toEqual(['fixture-key-12345']);
    expect(input.value).toBe('');
    expect(container.textContent).toContain('••••2345');
    expect(container.textContent).not.toContain('fixture-key-12345');
    const toggle = button(container, 'Allow history recall');
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => button(container, 'Check connection').click());
    expect(checks()).toBe(1);
    expect(container.textContent).toContain('Connection verified.');
    await act(async () => button(container, 'Delete saved key').click());
    expect(container.textContent).toContain('No API key registered');
    expect(button(container, 'Check connection').disabled).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

for (const outcome of ['success', 'failure'] as const) {
  test(`recall can be disabled during a pending connection check and stays off after its ${outcome}`, async () => {
    const check = createDeferred<boolean>();
    await withSettings(async ({ container, initial, recallWrites, checks }) => {
      await act(async () => initial.resolve({ ...saved, historyRecallEnabled: true }));
      const toggle = button(container, 'Allow history recall');
      const connection = button(container, 'Check connection');
      await act(async () => { connection.click(); connection.click(); });
      expect(checks()).toBe(1);
      expect(connection.disabled).toBe(true);
      expect(toggle.disabled).toBe(false);
      await act(async () => { toggle.click(); toggle.click(); });
      expect(recallWrites).toEqual([false]);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(connection.disabled).toBe(true);
      await act(async () => {
        if (outcome === 'success') check.resolve(true);
        else check.reject(new Error('Could not reach TypeSafe.'));
      });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(toggle.disabled).toBe(false);
      expect(connection.disabled).toBe(false);
      expect(recallWrites).toEqual([false]);
    }, { check: () => check.promise });
  });
}

test('finishing a connection check cannot unlock a pending recall save or hide its failure', async () => {
  const check = createDeferred<boolean>();
  const saving = createDeferred<void>();
  await withSettings(async ({ container, initial, recallWrites }) => {
    await act(async () => initial.resolve({ ...saved, historyRecallEnabled: true }));
    const toggle = button(container, 'Allow history recall');
    await act(async () => button(container, 'Check connection').click());
    await act(async () => toggle.click());
    expect(toggle.disabled).toBe(true);
    await act(async () => check.resolve(true));
    expect(toggle.disabled).toBe(true);
    await act(async () => toggle.click());
    expect(recallWrites).toEqual([false]);
    await act(async () => saving.resolve());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
  }, { check: () => check.promise, recallSave: saving.promise, failRecallSave: true });
});

test('a late key error cannot replace a recall save error', async () => {
  const check = createDeferred<boolean>();
  await withSettings(async ({ container, initial }) => {
    await act(async () => initial.resolve({ ...saved, historyRecallEnabled: true }));
    await act(async () => button(container, 'Check connection').click());
    await act(async () => button(container, 'Allow history recall').click());
    expect(container.textContent).toContain('Could not save the history recall setting.');
    await act(async () => check.reject(new Error('Could not reach TypeSafe.')));
    expect(container.textContent).toContain('Could not save the history recall setting.');
    expect(container.textContent).toContain('Could not reach TypeSafe.');
    expect(button(container, 'Allow history recall').getAttribute('aria-checked')).toBe('true');
  }, { check: () => check.promise, failRecallSave: true });
});

test('an older key reply cannot restore recall after a newer OFF reply without a broadcast', async () => {
  const removal = createDeferred<TypeSafeSettings>();
  await withSettings(async ({ container, initial, recallWrites, emit }) => {
    await act(async () => initial.resolve({ ...saved, historyRecallEnabled: true }));
    await act(async () => button(container, 'Delete saved key').click());
    const toggle = button(container, 'Allow history recall');
    expect(toggle.disabled).toBe(false);
    await act(async () => toggle.click());
    expect(recallWrites).toEqual([false]);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => removal.resolve({ ...none, historyRecallEnabled: true }));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // Deliver the final authoritative snapshot after the delayed IPC reply.
    await emit(none);
    expect(container.textContent).toContain('No API key registered');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  }, { removeReply: () => removal.promise, broadcast: false });
});

test('a stale initial load cannot replace updated settings and unavailable storage disables saving', async () => {
  await withSettings(async ({ container, initial, emit }) => {
    await emit(saved);
    await act(async () => initial.resolve(none));
    expect(container.textContent).toContain('Saved on this computer');
    expect(button(container, 'Allow history recall').disabled).toBe(false);
    await emit({ ...saved, canSave: false, maskedKey: null, error: 'Unlock the saved key.' });
    expect(container.querySelector('input')!.disabled).toBe(true);
    expect(button(container, 'Update key').disabled).toBe(true);
    expect(container.textContent).toContain('Unlock the saved key.');
    expect(button(container, 'Allow history recall').disabled).toBe(false);
  });
});

test('History recall toggle updates subscribers, persists selection and responds to another window', async () => {
  await withSettings(async ({ container, savedKeys, checks, initial, emit }) => {
    await act(async () => initial.resolve(saved));
    const toggle = button(container, 'Allow history recall');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await emit({ ...saved, historyRecallEnabled: false });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(savedKeys).toEqual([]);
    expect(checks()).toBe(0);
  });
});

test('loading settings disables recall but missing keys allow explicit Luna consent', async () => {
  await withSettings(async ({ container, initial }) => {
    const toggle = button(container, 'Allow history recall');
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => initial.resolve(none));
    expect(toggle.disabled).toBe(false);
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

test('an environment key enables the toggle and preserves an explicit saved ON preference', async () => {
  await withSettings(async ({ container, initial, emit }) => {
    const toggle = button(container, 'Allow history recall');
    expect(toggle.disabled).toBe(true);
    await act(async () => initial.resolve({ ...saved, source: 'environment', canSave: false, historyRecallEnabled: true }));
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await emit(none);
    expect(toggle.disabled).toBe(false);
    await emit(saved);
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

test('a failed recall save shows an error and leaves the toggle and recall off', async () => {
  await withSettings(async ({ container, initial }) => {
    await act(async () => initial.resolve(saved));
    const toggle = button(container, 'Allow history recall');
    await act(async () => toggle.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.disabled).toBe(false);
  }, { failRecallSave: true });
});

test('the toggle waits for persistence and ignores repeated clicks during saving', async () => {
  const saving = createDeferred<void>();
  await withSettings(async ({ container, initial }) => {
    await act(async () => initial.resolve(saved));
    const toggle = button(container, 'Allow history recall');
    await act(async () => { toggle.click(); toggle.click(); });
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => saving.resolve());
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  }, { recallSave: saving.promise });
});

test('a saved ON preference survives a temporary key lock and a stale initial reply', async () => {
  await withSettings(async ({ container, initial, emit }) => {
    await emit({ ...saved, historyRecallEnabled: true });
    await act(async () => initial.resolve(none));
    await emit({ ...saved, historyRecallEnabled: true, maskedKey: null, error: 'Unlock the saved key.' });
    await emit({ ...saved, historyRecallEnabled: true });
    expect(button(container, 'Allow history recall').getAttribute('aria-checked')).toBe('true');
  });
});


test('settings disclose recall providers, data scope and separate CLI skill execution before consent', async () => {
  await withSettings(async ({ container, initial }) => {
    await act(async () => initial.resolve(none));
    const disclosure = container.querySelector('#history-recall-disclosure')!.textContent!;
    for (const text of ['TypeSafe', 'OpenAI', 'Luna low', 'candidate conversation passages', 'nearby messages', 'Reopen the workspace',
      'applies to all workspaces, including ones opened later', 'Each search stays within the workspace where it is requested',
      'cancels pending recall in all workspaces']) {
      expect(disclosure).toContain(text);
    }
    expect(button(container, 'Allow history recall').getAttribute('aria-describedby')).toBe('history-recall-disclosure');
    expect(button(container, 'Allow history recall').getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('Saving a key does not enable history recall');
    expect(container.textContent).toContain('source checkout CLI');
    expect(container.textContent).not.toContain('Autopilot');
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
  await withSettings(async ({ container, window, initial, projectWrites }) => {
    await act(async () => initial.resolve(none));
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
  await withSettings(async ({ container, initial, emitLimit }) => {
    await act(async () => initial.resolve(none));
    await act(async () => category(container, 'Agents').click());
    await emitLimit(131072);
    await act(async () => load.resolve(32768));
    expect(container.querySelector<HTMLInputElement>('#project-doc-limit')!.value).toBe('128');
  }, { projectLoad: load.promise });
});

test('a rejected save keeps the prior saved instruction limit and remains retryable', async () => {
  await withSettings(async ({ container, window, initial, projectWrites }) => {
    await act(async () => initial.resolve(none));
    await act(async () => category(container, 'Agents').click());
    await enterInstructionLimit(container, window, '128');
    await act(async () => button(container, 'Save instruction size limit').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
    expect(button(container, 'Save instruction size limit').disabled).toBe(false);
    expect(projectWrites).toEqual([131072]);
    await act(async () => category(container, 'TypeSafe API').click());
    await act(async () => category(container, 'Agents').click());
    expect(container.querySelector<HTMLInputElement>('#project-doc-limit')!.value).toBe('32');
  }, { failProjectSave: true });
});
