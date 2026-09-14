import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import * as model from '../frontend/src/features/chat/model';
import * as queueModule from '../frontend/src/features/chat/chatMessageQueue';
import * as sendAttempt from '../frontend/src/features/chat/chatSendAttempt';
import * as sessionCache from '../frontend/src/features/chat/chatSessionCache';
import type { ChatController } from '../frontend/src/features/chat/useChatController';
import type { ChatDraftSnapshot } from '../frontend/src/features/chat/chatDraftRecovery';

interface HookSlot { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }
const draft = (text: string): ChatDraftSnapshot => ({ draft: text, selectedSkill: null, attachments: [] });
const complete = (threadId = 'main') => ({ type: 'turn-completed', threadId, status: 'completed' });

function harness() {
  const slots: HookSlot[] = [];
  const effects: (() => void)[] = [];
  const sends: unknown[][] = [];
  const steers: unknown[][] = [];
  const cancellations: unknown[][] = [];
  const busyThreads = new Set<string>();
  let cursor = 0;
  let queuePaused = false;
  let listener: ((event: unknown) => void) | undefined;
  const slot = () => slots[cursor++] ??= {};
  const equal = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));
  const react = {
    useState(initial: unknown) {
      const entry = slot();
      if (!Object.hasOwn(entry, 'value')) entry.value = typeof initial === 'function' ? initial() : initial;
      return [entry.value, (next: unknown) => { entry.value = typeof next === 'function' ? next(entry.value) : next; }];
    },
    useReducer(reducer: (state: unknown, action: unknown) => unknown, initial: unknown, initialize: (initial: unknown) => unknown) {
      const entry = slot();
      if (!Object.hasOwn(entry, 'value')) entry.value = initialize(initial);
      return [entry.value, (action: unknown) => { entry.value = reducer(entry.value, action); }];
    },
    useRef(initial: unknown) { return slot().value ??= { current: initial }; },
    useMemo(factory: () => unknown, dependencies: readonly unknown[]) {
      const entry = slot();
      if (!equal(entry.dependencies, dependencies)) { entry.value = factory(); entry.dependencies = dependencies; }
      return entry.value;
    },
    useCallback(callback: unknown, dependencies: readonly unknown[]) {
      return react.useMemo(() => callback, dependencies);
    },
    useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
      const entry = slot();
      if (equal(entry.dependencies, dependencies)) return;
      entry.dependencies = dependencies;
      effects.push(() => { entry.cleanup?.(); entry.cleanup = effect() ?? undefined; });
    },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { slot(); return snapshot(); },
  };
  const modules: Record<string, unknown> = {
    react,
    '../../shared/skillCatalogChanges': { completeSkillCatalogWorkflowTurn() {} },
    '../../cheshiDesktop': { cheshiDesktop: {
      onCodexChatEvent(callback: (event: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
      async openCodexChatSession(id: string) {
        return { session: { id, title: id, preview: '', createdAt: 1, updatedAt: 1, status: 'idle' }, items: [],
          responseInProgress: busyThreads.has(id), responseThreadIds: [...busyThreads] };
      },
      async sendCodexChatMessage(...args: unknown[]) { sends.push(args); return { threadId: args[4] }; },
      async steerCodexChatMessage(...args: unknown[]) { steers.push(args); return { threadId: args[4] }; },
      async cancelCodexChatResponse(...args: unknown[]) { cancellations.push(args); },
    } },
    './continueSavedChatTurn': { continueSavedChatTurn() { throw new Error('Unexpected saved-turn continuation'); } },
    './model': model,
    './chatMessageQueue': queueModule,
    './chatSendAttempt': sendAttempt,
    './chatSessionCache': sessionCache,
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/useChatController.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports, Error,
    window: { requestAnimationFrame() { throw new Error('Unexpected streaming text'); }, cancelAnimationFrame() {} },
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name]; },
  });
  const hook = exports.useChatController;
  assert.ok(typeof hook === 'function');
  const render = (): ChatController => { cursor = 0; return hook({ sessionSyncEnabled: false, contextId: 'pane', queuePaused }) as ChatController; };
  return {
    sends, steers, cancellations, busyThreads, render,
    setQueuePaused(value: boolean) { queuePaused = value; },
    emit(event: unknown) { assert.ok(listener); listener(event); },
    async flush() {
      let controller = render();
      for (let index = 0; index < 12; index++) {
        for (const effect of effects.splice(0)) effect();
        await Promise.resolve();
        controller = render();
      }
      return controller;
    },
    unmount() { for (const entry of slots) entry.cleanup?.(); },
  };
}

async function openBusy(app: ReturnType<typeof harness>) {
  app.busyThreads.add('main');
  let controller = await app.flush();
  expect(await controller.openSession('main')).toBe(true);
  controller = await app.flush();
  expect(model.isViewedSessionResponding(controller.state)).toBe(true);
  return controller;
}

test('queued input waits for completed idle state, then starts a new turn rather than steering', async () => {
  const app = harness();
  let controller = await openBusy(app);
  expect(controller.queueMessage(draft('After this task'))).toBe(true);
  controller = await app.flush();
  expect(controller.queuedMessages).toHaveLength(1);
  expect(app.sends).toHaveLength(0);
  expect(app.steers).toHaveLength(0);
  app.emit(complete());
  controller = await app.flush();
  expect(app.sends).toHaveLength(1);
  expect(app.sends[0]).toMatchObject({ 0: 'After this task', 4: 'main', 5: 'pane' });
  expect(app.steers).toHaveLength(0);
  expect(controller.queuedMessages).toHaveLength(0);
  app.unmount();
});

test('ordinary send during a response still steers, while a queued send guard rejects busy or different threads', async () => {
  const app = harness();
  let controller = await openBusy(app);
  expect((await controller.sendMessage('Guarded', null, [], 'main')).status).toBe('blocked');
  expect((await controller.sendMessage('Other thread', null, [], 'child')).status).toBe('blocked');
  expect((await controller.sendMessage('Immediate correction')).status).toBe('accepted');
  controller = await app.flush();
  expect(app.steers).toHaveLength(1);
  expect(app.steers[0]).toMatchObject({ 0: 'Immediate correction', 4: 'main' });
  expect(app.sends).toHaveLength(0);
  app.emit(complete());
  controller = await app.flush();
  expect((await controller.sendMessage('Other thread', null, [], 'child')).status).toBe('blocked');
  expect(app.sends).toHaveLength(0);
  app.unmount();
});

test('switching sessions hides but retains queued instructions and only drains upon returning to their thread', async () => {
  const app = harness();
  let controller = await openBusy(app);
  expect(controller.queueMessage(draft('For main only'))).toBe(true);
  expect(await controller.openSession('child')).toBe(true);
  controller = await app.flush();
  expect(controller.state.activeSessionId).toBe('child');
  expect(controller.queuedMessages).toHaveLength(0);
  expect(controller.queuedMessageCount).toBe(1);
  app.busyThreads.delete('main');
  app.emit(complete());
  controller = await app.flush();
  expect(app.sends).toHaveLength(0);
  expect(await controller.openSession('main')).toBe(true);
  controller = await app.flush();
  expect(app.sends).toHaveLength(1);
  expect(app.sends[0]).toMatchObject({ 0: 'For main only', 4: 'main' });
  expect(controller.queuedMessageCount).toBe(0);
  app.unmount();
});

test('Stop pauses the queue even if a successful completion arrives before cancellation finishes', async () => {
  const app = harness();
  let controller = await openBusy(app);
  expect(controller.queueMessage(draft('Remain paused'))).toBe(true);
  const cancellation = controller.cancelResponse();
  app.emit(complete());
  await cancellation;
  controller = await app.flush();
  expect(app.cancellations).toEqual([['main', 'pane']]);
  expect(app.sends).toHaveLength(0);
  expect(controller.queuedMessages[0]).toMatchObject({ status: 'paused' });
  const queued = controller.queuedMessages[0];
  assert.ok(queued);
  controller.retryQueuedMessage(queued.id);
  await app.flush();
  expect(app.sends).toHaveLength(1);
  app.unmount();
});

test('queue registration rejects idle chats and an in-progress session selection', async () => {
  const app = harness();
  let controller = await app.flush();
  expect(controller.queueMessage(draft('No current thread'))).toBe(false);
  expect(await controller.openSession('main')).toBe(true);
  controller = await app.flush();
  expect(controller.queueMessage(draft('Idle thread'))).toBe(false);
  app.emit({ type: 'turn-started', threadId: 'main' });
  controller = await app.flush();
  const switching = controller.openSession('child');
  expect(controller.queueMessage(draft('During selection'))).toBe(false);
  expect(app.render().state.phase).toBe('loading');
  await switching;
  controller = await app.flush();
  expect(controller.queuedMessageCount).toBe(0);
  app.unmount();
});


test('interaction locks prevent registration and automatic dispatch until the pane is unlocked', async () => {
  const app = harness();
  let controller = await openBusy(app);
  expect(controller.queueMessage(draft('Retain during account switch'))).toBe(true);
  app.setQueuePaused(true);
  controller = await app.flush();
  expect(controller.queueMessage(draft('Blocked while locked'))).toBe(false);
  app.emit(complete());
  controller = await app.flush();
  expect(app.sends).toHaveLength(0);
  expect(controller.queuedMessages).toHaveLength(1);
  app.setQueuePaused(false);
  controller = await app.flush();
  expect(app.sends).toHaveLength(1);
  expect(app.steers).toHaveLength(0);
  expect(controller.queuedMessageCount).toBe(0);
  app.unmount();
});
