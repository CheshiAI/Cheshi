import { expect, test } from 'bun:test';
import { observeWorkspaceHostLayout } from '../frontend/src/features/shell/workspaceHostLayout';
import { withDOM } from './agent-chats-test-dom';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(run: (state: {
  resize(width: number): void;
  flush(): void;
  requests: number[];
  gates: ReturnType<typeof createDeferred>[];
  errors: unknown[];
  dispose(): void;
}) => Promise<void>) {
  await withDOM(async () => {
    const saved = { ResizeObserver: globalThis.ResizeObserver };
    let width = 1200, notify = () => {};
    class Observer {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect() { notify = () => {}; }
    }
    const replace = (values: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, value });
    };
    replace({ ResizeObserver: Observer });
    const element = document.createElement('div');
    element.getBoundingClientRect = () => new window.DOMRect(78, 28, width, 720);
    const requests: number[] = [], gates: ReturnType<typeof createDeferred>[] = [], errors: unknown[] = [];
    const dispose = observeWorkspaceHostLayout(element, bounds => {
      expect(bounds.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
      requests.push(bounds.width);
      const gate = createDeferred(); gates.push(gate); return gate.promise;
    }, error => errors.push(error));
    try {
      await run({ requests, gates, errors, dispose,
        resize(value) { width = value; window.dispatchEvent(new window.Event('resize')); },
        flush() { notify(); },
      });
    } finally { dispose(); replace(saved); }
  });
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('coalesces resize sources and keeps animated bounds current while IPC replies are pending', async () => {
  await harness(async state => {
    expect(state.requests).toEqual([1200]);
    state.resize(1400); state.resize(1600); state.flush();
    expect(state.requests).toEqual([1200, 1600]);
    state.resize(1800); state.resize(2000); state.flush();
    expect(state.requests).toEqual([1200, 1600, 2000]);
    state.gates[0]!.resolve(); await settle(); state.flush();
    state.gates[1]!.resolve(); state.gates[2]!.resolve(); await settle(); state.resize(2000); state.flush();
    expect(state.requests).toEqual([1200, 1600, 2000]);
  });
});

test('retries unchanged geometry after a rejected request and reports its error', async () => {
  await harness(async state => {
    state.flush(); state.gates[0]!.reject(new Error('layout failed')); await settle();
    expect(state.errors).toHaveLength(1);
    state.resize(1200); state.flush(); expect(state.requests).toEqual([1200, 1200]);
    state.gates[1]!.resolve(); await settle();
  });
});

test('disposal ignores pending observer notifications and late errors', async () => {
  await harness(async state => {
    state.flush(); state.resize(1600); state.dispose();
    state.gates[0]!.reject(new Error('late failure')); await settle(); state.flush();
    state.resize(1800); state.flush();
    expect(state.requests).toEqual([1200]); expect(state.errors).toEqual([]);
  });
  await harness(async state => {
    state.dispose(); state.resize(1800); state.flush(); expect(state.requests).toEqual([1200]);
    state.gates[0]!.resolve(); await settle();
  });
});
