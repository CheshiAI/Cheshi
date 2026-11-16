import { expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { EventEmitter } from 'node:events';
import { CodexUpdateIndicator } from '../frontend/src/features/updates/CodexUpdateIndicator';
import { attachCodexUpdateWindow } from '../lib/codex-update-ipc.mts';
import { CODEX_UPDATE_CHANNEL, type CodexUpdateApi, type CodexUpdateState } from '../shared/codex-update';
import { withDOM } from './agent-chats-test-dom';

test('idle tooltip shows checked versions and a single check action', async () => {
  await withDOM(async ui => {
    const state: CodexUpdateState = { installedVersion: '0.163.0', availableVersion: '0.163.0', managed: true,
      busy: false, phase: 'idle', workers: { versions: ['0.163.0'], pending: 0, waiting: 0, errors: [] },
      detail: 'Local and worker versions checked. Existing local sessions keep their running process.', error: null, revision: 1 };
    let receive: ((value: CodexUpdateState) => void) | undefined;
    const api: Partial<CodexUpdateApi> = { getCodexUpdate: async () => state,
      onCodexUpdateChanged: listener => { receive = listener; return () => {}; } };
    await ui.render(<CodexUpdateIndicator api={api} />);
    expect(document.querySelector('button')?.getAttribute('aria-description'))
      .toBe('Local and workers: 0.163.0. Click to check for updates.');
    await act(async () => receive?.({ ...state, revision: 2, localUpdated: true }));
    expect(document.querySelector('button')?.getAttribute('aria-description')).toContain('Existing local sessions');
    await act(async () => receive?.({ ...state, revision: 3, localUpdated: false }));
    expect(document.querySelector('button')?.getAttribute('aria-description')).not.toContain('Existing local sessions');
  });
});

test('workspace surface receives equal-version completion and releases its subscription on close', async () => {
  await withDOM(async ui => {
    let state: CodexUpdateState = { installedVersion: '0.163.0', availableVersion: '0.163.0', managed: true,
      busy: true, phase: 'checking', workers: { versions: [], pending: 0, waiting: 0, errors: [] },
      detail: 'Waiting for worker access…', error: null, revision: 1,
      progress: { stage: 'waiting-lock', startedAt: Date.now(), updatedAt: Date.now() } };
    const listeners = new Set<(value: CodexUpdateState) => void>();
    const service = { snapshot: () => state, subscribe(listener: (value: CodexUpdateState) => void) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    } };
    let receive: ((value: CodexUpdateState) => void) | undefined, destroyed = false;
    const sent: CodexUpdateState[] = [];
    // This is the workspace's own contents, not its native host window.
    const surface = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed,
      webContents: { send(channel: string, value: CodexUpdateState) {
        expect(channel).toBe(`${CODEX_UPDATE_CHANNEL}:changed`);
        sent.push(value); receive?.(value);
      } } });
    const api: Partial<CodexUpdateApi> = { getCodexUpdate: async () => state,
      onCodexUpdateChanged(listener) { receive = listener; return () => { receive = undefined; }; } };
    await ui.render(<CodexUpdateIndicator api={api} />);
    const button = () => document.querySelector('button')!;
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().textContent).toContain('Waiting for worker access');
    // Completion can happen between the renderer's first read and runtime attachment.
    state = { ...state, busy: false, phase: 'idle', progress: null, revision: 2,
      workers: { versions: ['0.163.0'], pending: 0, waiting: 0, errors: [] }, detail: 'Versions checked.' };
    let dispose = () => {};
    try {
      await act(async () => { dispose = attachCodexUpdateWindow(surface, service); });
      expect(button().textContent).toBe('Codex CLI 0.163.0');
      expect(button().getAttribute('aria-busy')).toBe('false');
      expect(button().querySelector('svg')).toBeNull();
      expect(button().disabled).toBe(false);
      state = { ...state, busy: true, phase: 'checking', revision: 3 };
      await act(async () => { for (const listener of listeners) listener(state); });
      expect(button().getAttribute('aria-busy')).toBe('true');
      state = { ...state, busy: false, phase: 'idle', revision: 4 };
      await act(async () => { for (const listener of listeners) listener(state); });
      expect(button().textContent).toBe('Codex CLI 0.163.0');
      expect(button().getAttribute('aria-busy')).toBe('false');
      expect(button().querySelector('svg')).toBeNull();
      destroyed = true;
      surface.emit('closed');
      expect(listeners.size).toBe(0);
      expect(surface.listenerCount('closed')).toBe(0);
      const count = sent.length;
      dispose();
      attachCodexUpdateWindow(surface, service)();
      expect(listeners.size).toBe(0);
      expect(sent).toHaveLength(count);
      // Runtime disposal also unsubscribes without waiting for a close event.
      destroyed = false;
      await act(async () => { dispose = attachCodexUpdateWindow(surface, service); });
      expect(listeners.size).toBe(1);
      dispose();
      expect(listeners.size).toBe(0);
      expect(surface.listenerCount('closed')).toBe(0);
    } finally { dispose(); }
  });
});

test('status bar chooses local update, workers-only sync and check, and ignores stale state', async () => {
  await withDOM(async ui => {
    let state: CodexUpdateState = { installedVersion: '0.159.3', availableVersion: '0.163.0', managed: true,
      busy: false, phase: 'idle', workers: { versions: ['0.159.3'], pending: 0, waiting: 0, errors: [] }, detail: 'Ready', error: null, revision: 1 };
    let receive: ((s: CodexUpdateState) => void) | undefined, unsubscribed = false;
    const calls: string[] = [];
    const api: CodexUpdateApi = { getCodexUpdate: async () => state, checkCodexUpdate: async () => { calls.push('check'); return state; },
      installCodexUpdate: async () => { calls.push('install'); return state; }, syncWorkerCodex: async () => { calls.push('workers'); return state; },
      onCodexUpdateChanged(listener) { receive = listener; return () => { unsubscribed = true; }; } };
    await ui.render(<CodexUpdateIndicator api={api} />);
    await ui.click('Update Codex and workers · Codex CLI 0.159.3'); expect(calls).toEqual(['install']);
    state = { ...state, installedVersion: '0.163.0', workers: { ...state.workers, pending: 1 }, revision: 2 };
    await act(async () => receive?.(state));
    await ui.click('Update workers · Codex CLI 0.163.0'); expect(calls.at(-1)).toBe('workers');
    await act(async () => receive?.({ ...state, installedVersion: '0.159.3', revision: 1 }));
    expect(document.body.textContent).toContain('Codex CLI 0.163.0');
    state = { ...state, busy: true, phase: 'workers', revision: 3 }; await act(async () => receive?.(state));
    expect(document.querySelector('button')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Updating workers');
    state = { ...state, busy: false, phase: 'idle', workers: { ...state.workers, pending: 0 }, revision: 4 };
    await act(async () => receive?.(state));
    await ui.click('Check for updates · Codex CLI 0.163.0'); expect(calls.at(-1)).toBe('check');
    await ui.render(null); expect(unsubscribed).toBe(true);
  });
});

test('shows stages, elapsed time and stalled reporting, then clears them on recovery and completion', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    await withDOM(async ui => {
      let state: CodexUpdateState = { installedVersion: '0.163.0', availableVersion: '0.163.0', managed: true,
        busy: true, phase: 'workers', workers: { versions: ['0.159.3'], pending: 1, waiting: 0, errors: [] },
        detail: 'Old waiting message', error: null, revision: 1,
        progress: { stage: 'dependencies', startedAt: 10_000, updatedAt: 20_000 } };
      let receive: ((value: CodexUpdateState) => void) | undefined;
      const api: Partial<CodexUpdateApi> = { getCodexUpdate: async () => state,
        onCodexUpdateChanged: listener => { receive = listener; return () => {}; } };
      await ui.render(<CodexUpdateIndicator api={api} />);
      const button = () => document.querySelector('button')!;
      expect(button().textContent).toContain('Preparing worker dependencies… 90s');
      expect(button().textContent).toContain('Taking longer than expected');
      expect(button().dataset.delayed).toBe('true');
      expect(button().disabled).toBe(true);
      expect(button().querySelector('svg')).not.toBeNull();
      // Real progress restarts the quiet timer, not the operation's elapsed time.
      state = { ...state, revision: 2, progress: { stage: 'verifying-worker', startedAt: 10_000, updatedAt: 100_000 } };
      await act(async () => receive?.(state));
      expect(button().textContent).toContain('Verifying worker… 90s');
      expect(button().dataset.delayed).toBeUndefined();
      clock.mockReturnValue(102_000);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
      expect(button().textContent).toContain('92s');
      state = { ...state, busy: false, phase: 'idle', revision: 3, progress: null,
        workers: { versions: ['0.163.0'], pending: 0, waiting: 0, errors: [] } };
      await act(async () => receive?.(state));
      expect(button().textContent).toBe('Codex CLI 0.163.0');
      expect(button().querySelector('svg')).toBeNull();
      expect(button().disabled).toBe(false);
      state = { ...state, revision: 4, error: 'Docker command timed out. Retry Update workers.' };
      await act(async () => receive?.(state));
      expect(button().textContent).toContain('Retry');
      expect(button().getAttribute('aria-busy')).toBe('false');
    });
  } finally { clock.mockRestore(); }
});
