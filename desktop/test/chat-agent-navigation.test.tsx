import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { ChatAgentThread } from '../frontend/src/features/chat/model';
import type { useChatAgentNavigation } from '../frontend/src/features/chat/useChatAgentNavigation';

type Options = Parameters<typeof useChatAgentNavigation>[0];
type Navigation = ReturnType<typeof useChatAgentNavigation>;
interface HookSlot {
  value?: unknown;
  dependencies?: readonly unknown[];
  cleanup?: () => void;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function sameDependencies(previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
  return previous?.length === next.length && next.every((value, index) => Object.is(value, previous[index]));
}

function agent(id: string, parentThreadId: string | null = null, depth = 0): ChatAgentThread {
  return {
    id, parentThreadId, depth, kind: parentThreadId ? 'subagent' : 'main',
    title: id, description: '', role: null, status: 'notLoaded', current: false,
  };
}

const tree = [agent('main'), agent('child', 'main', 1), agent('nested', 'child', 2)];

function harness(overrides: Partial<Options> = {}) {
  const opened: string[] = [];
  let options: Options = {
    activeSessionId: 'child', listAgents: async () => tree,
    openAgent: async (id: string) => { opened.push(id); },
    isOperationPending: () => false, ...overrides,
  };
  const slots: HookSlot[] = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  let writes = 0;
  const nextSlot = (): HookSlot => slots[cursor++] ??= {};
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const slot = nextSlot();
        if (!Object.hasOwn(slot, 'value')) slot.value = typeof initial === 'function' ? initial() : initial;
        return [slot.value, (next: unknown) => {
          writes++;
          slot.value = typeof next === 'function' ? next(slot.value) : next;
        }];
      },
      useRef(initial: unknown) {
        const slot = nextSlot();
        return slot.value ??= { current: initial };
      },
      useCallback(callback: unknown, dependencies: readonly unknown[]) {
        const slot = nextSlot();
        if (!sameDependencies(slot.dependencies, dependencies)) {
          slot.value = callback;
          slot.dependencies = dependencies;
        }
        return slot.value;
      },
      useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
        const slot = nextSlot();
        if (sameDependencies(slot.dependencies, dependencies)) return;
        slot.dependencies = dependencies;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect() ?? undefined;
        });
      },
    },
    '../../shared/errorMessage': {
      errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/useChatAgentNavigation.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports, Error,
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  const hook = exports.useChatAgentNavigation;
  assert.ok(typeof hook === 'function');
  return {
    opened,
    get writes() { return writes; },
    render(next: Partial<Options> = {}): Navigation {
      options = { ...options, ...next };
      cursor = 0;
      return hook(options) as Navigation;
    },
    flushEffects() { for (const effect of effects.splice(0)) effect(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

test('a new main session does not query unpersisted agent history, including after a stale catalog refresh', async () => {
  let requests = 0;
  const app = harness({ activeSessionId: 'new-main', isKnownMainSession: true, listAgents: async () => {
    requests += 1;
    throw new Error('The conversation was not found in any registered account.');
  } });
  app.render();
  app.flushEffects();
  await settle();
  expect(app.render().mainThreadId).toBeNull();
  expect(app.render().error).toBeNull();
  app.render({ isKnownMainSession: false });
  app.flushEffects();
  await settle();
  expect(requests).toBe(0);
  expect(app.render().error).toBeNull();
  app.unmount();
});

test('entering a subagent after a known main still resolves its return target', async () => {
  let requests = 0;
  const app = harness({ activeSessionId: 'main', isKnownMainSession: true, listAgents: async () => {
    requests += 1;
    return tree;
  } });
  app.render();
  app.flushEffects();
  await settle();
  app.render({ activeSessionId: 'child', isKnownMainSession: false });
  app.flushEffects();
  await settle();
  expect(requests).toBe(1);
  expect(app.render().mainThreadId).toBe('main');
  await app.render().returnToMain();
  expect(app.opened).toEqual(['main']);
  app.unmount();
});

for (const id of ['child', 'nested']) {
  test(`returns ${id} directly to the main agent, including unloaded nested agents`, async () => {
    const app = harness({ activeSessionId: id });
    expect(app.render().mainThreadId).toBeNull();
    app.flushEffects();
    await settle();
    const navigation = app.render();
    expect(navigation.mainThreadId).toBe('main');
    await navigation.returnToMain();
    expect(app.opened).toEqual(['main']);
    expect(app.render().returning).toBe(false);
    app.unmount();
  });
}

for (const id of ['main', 'unknown', null]) {
  test(`does not offer return navigation for active session ${id}`, async () => {
    const app = harness({ activeSessionId: id });
    app.render();
    app.flushEffects();
    await settle();
    const navigation = app.render();
    expect(navigation.mainThreadId).toBeNull();
    await navigation.returnToMain();
    expect(app.opened).toEqual([]);
    app.unmount();
  });
}

test('hides the old return target immediately on session change and ignores a late lookup', async () => {
  const first = createDeferred<ChatAgentThread[]>();
  const second = createDeferred<ChatAgentThread[]>();
  let requests = 0;
  const app = harness({ listAgents: () => ++requests === 1 ? first.promise : second.promise });
  app.render();
  app.flushEffects();
  expect(app.render({ activeSessionId: 'other-child' }).mainThreadId).toBeNull();
  app.flushEffects();
  second.resolve([agent('other-main'), agent('other-child', 'other-main', 1)]);
  await settle();
  expect(app.render().mainThreadId).toBe('other-main');
  first.resolve(tree);
  await settle();
  const navigation = app.render();
  expect(navigation.mainThreadId).toBe('other-main');
  await navigation.returnToMain();
  expect(app.opened).toEqual(['other-main']);
  app.unmount();
});

test('does not keep a resolved subagent return target after switching to main', async () => {
  const app = harness();
  app.render();
  app.flushEffects();
  await settle();
  expect(app.render().mainThreadId).toBe('main');
  const navigation = app.render({ activeSessionId: 'main' });
  expect(navigation.mainThreadId).toBeNull();
  await navigation.returnToMain();
  expect(app.opened).toEqual([]);
  app.flushEffects();
  await settle();
  expect(app.render().mainThreadId).toBeNull();
  app.unmount();
});

test('blocks repeated clicks before rerender and while the return request is pending', async () => {
  const pending = createDeferred<void>();
  const opened: string[] = [];
  const app = harness({ openAgent: (id: string) => { opened.push(id); return pending.promise; } });
  app.render();
  app.flushEffects();
  await settle();
  const navigation = app.render();
  const first = navigation.returnToMain();
  await navigation.returnToMain();
  const busy = app.render();
  expect(busy.returning).toBe(true);
  await busy.returnToMain();
  expect(opened).toEqual(['main']);
  pending.resolve();
  await first;
  expect(app.render().returning).toBe(false);
  app.unmount();
});

test('checks an existing operation at click time and allows returning once it ends', async () => {
  let pending = false;
  const app = harness({ isOperationPending: () => pending });
  app.render();
  app.flushEffects();
  await settle();
  const navigation = app.render();
  pending = true;
  await navigation.returnToMain();
  expect(app.opened).toEqual([]);
  expect(app.render().returning).toBe(false);
  pending = false;
  await navigation.returnToMain();
  expect(app.opened).toEqual(['main']);
  app.unmount();
});

test('shows a return failure, supports dismissing it, and allows retrying', async () => {
  let attempts = 0;
  const app = harness({ openAgent: async () => {
    if (++attempts === 1) throw new Error('Cannot open main agent');
  } });
  app.render();
  app.flushEffects();
  await settle();
  await app.render().returnToMain();
  const failed = app.render();
  expect(failed.error).toBe('Cannot open main agent');
  expect(failed.returning).toBe(false);
  expect(failed.mainThreadId).toBe('main');
  failed.dismissError();
  expect(app.render().error).toBeNull();
  await app.render().returnToMain();
  expect(attempts).toBe(2);
  expect(app.render().error).toBeNull();
  app.unmount();
});

test('ignores a lookup response after unmount', async () => {
  const pending = createDeferred<ChatAgentThread[]>();
  const app = harness({ listAgents: () => pending.promise });
  app.render();
  app.flushEffects();
  app.unmount();
  const writes = app.writes;
  pending.resolve(tree);
  await settle();
  expect(app.writes).toBe(writes);
});

test('ignores return failures and completion updates after unmount', async () => {
  const pending = createDeferred<void>();
  const app = harness({ openAgent: () => pending.promise });
  app.render();
  app.flushEffects();
  await settle();
  const returning = app.render().returnToMain();
  app.unmount();
  const writes = app.writes;
  pending.reject(new Error('Late return failure'));
  await returning;
  expect(app.writes).toBe(writes);
});
