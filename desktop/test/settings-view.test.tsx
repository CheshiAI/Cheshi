import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { FlashReadiness, SettingsApi } from '../shared/settings';
import { product } from '../../config/product.mts';
import type { HomieSetupStatus } from '../shared/homie-setup';

const homieStatus: HomieSetupStatus = { supported: true, brew: true, docker: true, colima: true,
  connected: false, securityReady: false, busy: false, detail: 'Colima is stopped.' };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function withSettings(run: (view: {
  container: HTMLElement; window: Window; projectWrites: number[]; flashWrites: boolean[];
  emitHomies(enabled: boolean): Promise<void>; homiesWrites: boolean[];
  emitFlash(enabled: boolean): Promise<void>; emitLimit(bytes: number): Promise<void>;
}) => Promise<void>, options: {
  projectLoad?: Promise<number>; projectSave?: Promise<void>; failProjectSave?: boolean;
  flashLoad?: Promise<boolean>; flashSave?: Promise<void>; failFlashSave?: boolean;
  readiness?: FlashReadiness; install?: Promise<FlashReadiness>;
  homies?: HomieSetupStatus;
  homieInstall?: () => Promise<HomieSetupStatus>;
  homieStart?: () => Promise<HomieSetupStatus>;
  homieCheck?: () => Promise<HomieSetupStatus>;
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
  let flashEnabled = false;
  const flashWrites: boolean[] = [];
  const flashListeners = new Set<(enabled: boolean) => void>();
  let homiesEnabled = false;
  const homiesListeners = new Set<(enabled: boolean) => void>();
  const homiesWrites: boolean[] = [];
  const api: SettingsApi = {
    getHomiesEnabled: async () => homiesEnabled,
    setHomiesEnabled: async enabled => {
      homiesWrites.push(enabled); homiesEnabled = enabled;
      for (const listener of homiesListeners) listener(enabled);
      return enabled;
    },
    onHomiesEnabledChanged: listener => { homiesListeners.add(listener); return () => { homiesListeners.delete(listener); }; },
    getHomieSetup: options.homieCheck ?? (async () => options.homies ?? homieStatus),
    installHomieTools: options.homieInstall ?? (async () => homieStatus),
    startHomieEngine: options.homieStart ?? (async () => ({ ...homieStatus, connected: true, securityReady: true, detail: 'Connection ready.' })),
    getFlashReadiness: async () => options.readiness ?? { ready: true, detail: 'Files available.' },
    checkFlashUpdates: async () => ({ ready: true, detail: 'Installed.', installedVersion: '0.1.0', availableVersion: '0.2.0' }),
    uninstallFlash: async () => ({ ready: false, detail: 'Flash plugin removed. Saved conversations and model files have been kept.' }),
    installFlash: async () => options.install ?? { ready: true, detail: 'Installed.' },
    getFlashEnabled: async () => options.flashLoad ?? flashEnabled,
    setFlashEnabled: async enabled => {
      flashWrites.push(enabled); await options.flashSave;
      if (options.failFlashSave) throw new Error('Could not save');
      flashEnabled = enabled;
      for (const listener of flashListeners) listener(enabled);
      return enabled;
    },
    onFlashEnabledChanged: handler => { flashListeners.add(handler); return () => { flashListeners.delete(handler); }; },
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
    await run({ container, window, projectWrites, flashWrites, homiesWrites,
      emitHomies: async enabled => { homiesEnabled = enabled; await act(async () => { for (const listener of homiesListeners) listener(enabled); }); },
      emitFlash: async enabled => { await act(async () => { for (const listener of flashListeners) listener(enabled); }); },
      emitLimit: async bytes => { await act(async () => { for (const listener of projectListeners) listener(bytes); }); } });
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function button(container: HTMLElement, label: string) {
  const control = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label);
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

test('settings keeps provider credentials and old memory recall controls removed', async () => {
  await withSettings(async ({ container }) => {
    expect(category(container, 'Agents').getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('#history-recall-disclosure')).toBeNull();
    expect(container.textContent).not.toContain('TypeSafe');
    expect(container.textContent).not.toContain('Jev');
    expect([...container.querySelectorAll('aside button')].map(item => item.textContent))
      .toEqual(['Agents', 'Homies', 'Appearance', 'Notifications', 'Scheduler', 'Flash', 'About']);
  });
});

test('Flash defaults off, saves both states and restores the value when reopening settings', async () => {
  await withSettings(async ({ container, flashWrites, emitFlash }) => {
    await act(async () => category(container, 'Flash').click());
    const toggle = () => button(container, 'Enable Flash memory');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => category(container, 'About').click());
    await act(async () => category(container, 'Flash').click());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle().click());
    expect(flashWrites).toEqual([true, false]);
    await emitFlash(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('Chat and conversation list search remain available.');
  });
});

test('Flash ignores stale initial reads after another window changes the setting', async () => {
  const load = createDeferred<boolean>();
  await withSettings(async ({ container, emitFlash }) => {
    await act(async () => category(container, 'Flash').click());
    expect(button(container, 'Enable Flash memory').disabled).toBe(true);
    await emitFlash(true);
    await act(async () => load.resolve(false));
    expect(button(container, 'Enable Flash memory').getAttribute('aria-checked')).toBe('true');
  }, { flashLoad: load.promise });
});

test('Flash prevents repeated saves and retains its prior value when saving fails', async () => {
  const save = createDeferred<void>();
  await withSettings(async ({ container, flashWrites }) => {
    await act(async () => category(container, 'Flash').click());
    const toggle = button(container, 'Enable Flash memory');
    await act(async () => { toggle.click(); toggle.click(); });
    expect(flashWrites).toEqual([true]);
    expect(toggle.disabled).toBe(true);
    await act(async () => save.resolve());
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save Flash');
  }, { flashSave: save.promise, failFlashSave: true });
});

test('Flash blocks ON for missing files, offers installation, and leaves OFF until explicitly enabled', async () => {
  const install = createDeferred<FlashReadiness>();
  await withSettings(async ({ container, flashWrites }) => {
    await act(async () => category(container, 'Flash').click());
    expect(button(container, 'Enable Flash memory').disabled).toBe(true);
    expect(container.textContent).toContain('Missing model');
    await act(async () => button(container, 'Install Flash').click());
    expect(button(container, 'Installing Flash…').disabled).toBe(true);
    expect(button(container, 'Enable Flash memory').getAttribute('aria-checked')).toBe('false');
    await act(async () => install.resolve({ ready: true, detail: 'Installed successfully' }));
    expect(button(container, 'Enable Flash memory').disabled).toBe(false);
    expect(flashWrites).toEqual([]);
    await act(async () => button(container, 'Enable Flash memory').click());
    expect(flashWrites).toEqual([true]);
  }, { readiness: { ready: false, detail: 'Missing model' }, install: install.promise });
});

test('Flash can always be turned OFF even if files later disappear', async () => {
  await withSettings(async ({ container, flashWrites, emitFlash }) => {
    await act(async () => category(container, 'Flash').click());
    await emitFlash(true);
    expect(button(container, 'Enable Flash memory').disabled).toBe(false);
    expect(button(container, 'Install Flash').disabled).toBe(true);
    await act(async () => button(container, 'Enable Flash memory').click());
    expect(flashWrites).toEqual([false]);
  }, { readiness: { ready: false, detail: 'Missing executable' } });
});

test('Flash displays model byte progress and keeps it when settings are reopened during installation', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Flash').click());
    const verify = () => {
      const progress = container.querySelector('progress');
      expect(progress?.getAttribute('value')).toBe('25');
      expect(container.textContent).toContain('Model download 25%');
      expect(container.textContent).toContain('25.0 / 100.0 MiB (including reused files)');
      expect(button(container, 'Enable Flash memory').disabled).toBe(true);
    };
    verify();
    await act(async () => category(container, 'About').click());
    await act(async () => category(container, 'Flash').click());
    verify();
  }, { readiness: { ready: false, installing: true, detail: 'Downloading model',
    progress: { startedAt: Date.now() - 61000, downloadedBytes: 25 * 1048576, totalBytes: 100 * 1048576 } } });
});

test('Flash unknown-size stages show elapsed time without an invented percentage', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Flash').click());
    expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
    expect(container.textContent).toContain('Preparing Python');
    expect(container.textContent).toContain('1m 1s elapsed');
    expect(container.textContent).not.toContain('%');
  }, { readiness: { ready: false, installing: true, detail: 'Preparing Python', progress: { startedAt: Date.now() - 61000 } } });
});

test('Flash model loading shows a ticking elapsed time and clears it only after activation finishes', async () => {
  const save = createDeferred<void>();
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Flash').click());
    await act(async () => button(container, 'Enable Flash memory').click());
    expect(container.textContent).toContain('Checking Flash and loading the model… · 0m 0s elapsed');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(container.textContent).toContain('0m 1s elapsed');
    expect(container.querySelector('progress')).toBeNull();
    await act(async () => save.resolve());
    expect(container.textContent).toContain('Flash is on.');
    expect(container.textContent).not.toContain('elapsed');
  }, { flashSave: save.promise });
});

test('Flash shows installed and available versions and removes only while disabled', async () => {
  await withSettings(async ({ container, emitFlash }) => {
    await act(async () => category(container, 'Flash').click());
    expect(container.textContent).toContain('Installed Flash plugin: 0.1.0');
    await act(async () => button(container, 'Check updates').click());
    expect(container.textContent).toContain('Flash 0.2.0 is available.');
    expect(button(container, 'Update Flash').disabled).toBe(false);
    await emitFlash(true);
    expect(button(container, 'Update Flash').disabled).toBe(true);
    expect(button(container, 'Remove Flash').disabled).toBe(true);
    await emitFlash(false);
    await act(async () => button(container, 'Remove Flash').click());
    expect(container.textContent).toContain('Saved conversations and model files have been kept.');
    expect(container.textContent).not.toContain('Installed Flash plugin:');
    expect(button(container, 'Enable Flash memory').disabled).toBe(true);
  }, { readiness: { ready: true, detail: 'Ready', installedVersion: '0.1.0' } });
});

test('Flash package downloads have their own percentage label', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Flash').click());
    expect(container.textContent).toContain('Plugin download 50%');
    expect(container.textContent).not.toContain('Model download');
    expect(container.textContent).not.toContain('including reused files');
  }, { readiness: { ready: false, installing: true, detail: 'Downloading plugin',
    progress: { startedAt: Date.now(), phase: 'package', downloadedBytes: 50, totalBytes: 100 } } });
});

test('Homies separates installed tools from connection and connects through its start action', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    expect(container.textContent).toContain('Not connected');
    expect(button(container, 'Install missing tools').disabled).toBe(true);
    expect(button(container, 'Start Colima').disabled).toBe(false);
    await act(async () => button(container, 'Start Colima').click());
    expect(container.textContent).toContain('Connection ready.');
    expect(button(container, 'Prepare Homies').disabled).toBe(true);
  });
});

test('Homies guides missing Homebrew and restores ongoing progress when reopened', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    expect(container.querySelector('a[href="https://brew.sh"]')).not.toBeNull();
    expect(button(container, 'Install missing tools').disabled).toBe(true);
  }, { homies: { ...homieStatus, brew: false, docker: false, colima: false } });
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    expect(container.textContent).toContain('1m 1s elapsed');
    expect(container.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(container.textContent).not.toContain('%');
    expect(button(container, 'Start Colima').disabled).toBe(true);
    await act(async () => category(container, 'About').click());
    await act(async () => category(container, 'Homies').click());
    expect(container.textContent).toContain('Downloading Colima');
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  }, { homies: { ...homieStatus, busy: true, startedAt: Date.now() - 61000, detail: 'Downloading Colima' } });
});

test('Homies displays installation failure and allows retry', async () => {
  const initial = { ...homieStatus, docker: false, colima: false };
  let calls = 0;
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    await act(async () => button(container, 'Install missing tools').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Download failed');
    expect(button(container, 'Install missing tools').disabled).toBe(false);
    await act(async () => button(container, 'Install missing tools').click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button(container, 'Start Colima').disabled).toBe(false);
  }, { homies: initial, homieInstall: async () => ++calls === 1 ? { ...initial, error: 'Download failed. Retry.' } : homieStatus });
  expect(calls).toBe(2);
});

test('manual Homies checks remain visible for at least one second while automatic checks stay quiet', async () => {
  let calls = 0;
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    const before = calls;
    await act(async () => button(container, 'Check status').click());
    expect(calls).toBe(before + 1);
    expect(button(container, 'Check status').textContent).toBe('Checking…');
    expect(container.textContent).toContain('Checking the Homies environment…');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(button(container, 'Check status').disabled).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(button(container, 'Check status').disabled).toBe(false);
  }, { homieCheck: async () => { calls++; return homieStatus; } });
});

test('a slow Homies check waits for completion without adding another second', async () => {
  const check = createDeferred<HomieSetupStatus>();
  let calls = 0;
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    await act(async () => button(container, 'Check status').click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    await act(async () => check.resolve({ ...homieStatus, connected: true, securityReady: true, detail: 'Connection ready.' }));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toContain('Connection ready.');
  }, { homieCheck: async () => ++calls === 1 ? homieStatus : check.promise });
});

test('a failed manual Homies check also retains its indicator and allows retry', async () => {
  let calls = 0;
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    await act(async () => button(container, 'Check status').click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not complete');
    expect(button(container, 'Check status').disabled).toBe(false);
  }, { homieCheck: async () => {
    if (++calls > 1) throw new Error('fixture check failed');
    return homieStatus;
  } });
});

test('leaving Homies during the minimum display does not leave a busy indicator on return', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    await act(async () => button(container, 'Check status').click());
    await act(async () => category(container, 'About').click());
    await act(async () => category(container, 'Homies').click());
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(button(container, 'Check status').disabled).toBe(false);
  });
});

test('Homies switch requires readiness, follows other windows and remains available to turn off when disconnected', async () => {
  await withSettings(async ({ container, emitHomies, homiesWrites }) => {
    await act(async () => category(container, 'Homies').click());
    const control = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable Homies"]')!;
    expect(control().disabled).toBe(true); expect(control().getAttribute('aria-checked')).toBe('false');
    await emitHomies(true);
    expect(control().disabled).toBe(false); expect(control().getAttribute('aria-checked')).toBe('true');
    await act(async () => control().click());
    expect(homiesWrites).toEqual([false]); expect(control().getAttribute('aria-checked')).toBe('false');
  });
  await withSettings(async ({ container, homiesWrites }) => {
    await act(async () => category(container, 'Homies').click());
    const control = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable Homies"]')!;
    expect(control.disabled).toBe(false);
    await act(async () => control.click());
    expect(homiesWrites).toEqual([true]); expect(control.getAttribute('aria-checked')).toBe('true');
  }, { homies: { ...homieStatus, connected: true, securityReady: true } });
});

test('connected Colima still requires security preparation before enabling Homies', async () => {
  await withSettings(async ({ container }) => {
    await act(async () => category(container, 'Homies').click());
    const enable = () => container.querySelector<HTMLButtonElement>('[aria-label="Enable Homies"]')!;
    expect(container.textContent).toContain('Preparation required');
    expect(enable().disabled).toBe(true);
    expect(button(container, 'Prepare Homies').disabled).toBe(false);
    await act(async () => button(container, 'Prepare Homies').click());
    expect(enable().disabled).toBe(false);
  }, { homies: { ...homieStatus, connected: true, securityReady: false } });
});
