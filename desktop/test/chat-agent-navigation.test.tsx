import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import type { useChatController } from '../frontend/src/features/chat/useChatController';
import { previousAgentThread, recordAgentNavigation } from '../frontend/src/features/chat/chatAgentNavigation';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

function harness() {
  const slots: unknown[] = [];
  const effects: (() => unknown)[] = [];
  let cursor = 0;
  let mounted = false;
  const calls: string[] = [];
  const requests: string[] = [];
  const allowedIds = new Set<string>();
  let agentIds = ['main', 'child', 'grandchild', 'other', 'other-child'];
  let fail = false;
  let listFailure = false;
  let gate: Promise<void> | null = null;
  let listGate: Promise<void> | null = null;
  const opened = (id: string) => ({ session: { id, title: id }, items: [] });
  function useState(initial: unknown) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => {
      slots[index] = typeof value === 'function' ? value(slots[index]) : value;
    }];
  }
  const modules: Record<string, unknown> = {
    react: {
      useState,
      useRef(current: unknown) { return slots[cursor++] ??= { current }; },
      useCallback(callback: unknown) { return callback; },
      useMemo(callback: () => unknown) { return callback(); },
      useEffect(effect: () => unknown) { if (!mounted) effects.push(effect); },
      useReducer(reducer: (state: unknown, action: unknown) => unknown, initial: unknown, init: (value: unknown) => unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = init(initial);
        return [slots[index], (action: unknown) => { slots[index] = reducer(slots[index], action); }];
      },
    },
    '../../cheshiDesktop': { cheshiDesktop: {
      openCodexChatSession: async (id: string) => opened(id),
      newCodexChatSession: async () => undefined,
      async listCodexChatAgents(contextId: string) {
        requests.push(`${contextId}:list`);
        if (listGate) await listGate;
        if (listFailure) throw new Error('Agent list unavailable');
        allowedIds.clear();
        for (const id of agentIds) allowedIds.add(id);
        return { agents: agentIds.map(id => ({ id, title: id, parentThreadId: id === 'main' ? null : 'main',
          kind: id === 'main' ? 'main' : 'subagent', role: null, depth: id === 'main' ? 0 : 1,
          status: 'idle', current: false })) };
      },
      async openCodexChatAgent(id: string, contextId: string) {
        calls.push(`${contextId}:${id}`);
        requests.push(`${contextId}:open:${id}`);
        if (gate) await gate;
        if (fail) throw new Error('Agent unavailable');
        if (!allowedIds.has(id)) throw new Error('The selected Codex agent thread is no longer available.');
        allowedIds.clear();
        return opened(id);
      },
    } },
  };
  const filename = new URL('../frontend/src/features/chat/useChatController.ts', import.meta.url);
  const localRequire = createRequire(filename);
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  vm.runInNewContext(compiled.outputText, { exports, Error, require: (name: string) => modules[name] ?? localRequire(name) });
  const hook = exports.useChatController as typeof useChatController;
  function render() {
    cursor = 0;
    const result = hook({ sessionSyncEnabled: false, contextId: 'pane-a' });
    effects.splice(0).forEach(effect => effect());
    mounted = true;
    return result;
  }
  return {
    calls, requests, render,
    fail(value: boolean) { fail = value; },
    waitFor(value: Promise<void> | null) { gate = value; },
    failList(value: boolean) { listFailure = value; },
    listOnly(ids: string[]) { agentIds = ids; },
    waitForList(value: Promise<void> | null) { listGate = value; },
    async openAgent(id: string) {
      await render().listAgents();
      await render().openAgent(id);
    },
  };
}

test('nested agents return one step at a time and retain only thread ids', async () => {
  const app = harness();
  await app.render().openSession('main');
  expect(app.render().agentBackThreadId).toBeNull();
  await app.openAgent('child');
  expect(app.render().agentBackThreadId).toBe('main');
  await app.openAgent('grandchild');
  expect(app.render().agentBackThreadId).toBe('child');
  await app.render().goBackFromAgent();
  expect(app.render().state.activeSessionId).toBe('child');
  await app.render().goBackFromAgent();
  expect(app.render().state.activeSessionId).toBe('main');
  expect(app.render().agentBackThreadId).toBeNull();
  expect(app.calls).toEqual(['pane-a:child', 'pane-a:grandchild', 'pane-a:child', 'pane-a:main']);
  expect(app.requests.slice(-4)).toEqual(['pane-a:list', 'pane-a:open:child', 'pane-a:list', 'pane-a:open:main']);
});

test('failed back navigation preserves the current thread and allows retry', async () => {
  const app = harness();
  await app.render().openSession('main');
  await app.openAgent('child');
  app.fail(true);
  await app.render().goBackFromAgent();
  expect(app.render().state.activeSessionId).toBe('child');
  expect(app.render().agentBackThreadId).toBe('main');
  expect(app.render().agentNavigationPending).toBe(false);
  app.fail(false);
  await app.render().goBackFromAgent();
  expect(app.render().state.activeSessionId).toBe('main');
});

test('repeated back clicks send one request while navigation is pending', async () => {
  const app = harness();
  await app.render().openSession('main');
  await app.openAgent('child');
  const gate = createDeferred();
  app.waitFor(gate.promise);
  const pending = app.render().goBackFromAgent();
  expect(app.render().agentNavigationPending).toBe(true);
  await app.render().goBackFromAgent();
  await Promise.resolve();
  expect(app.calls).toEqual(['pane-a:child', 'pane-a:main']);
  gate.resolve();
  await pending;
  expect(app.render().agentNavigationPending).toBe(false);
});

test('opening another conversation or a new chat clears the back path', async () => {
  const app = harness();
  await app.render().openSession('main');
  await app.openAgent('child');
  await app.render().openSession('other');
  expect(app.render().agentBackThreadId).toBeNull();
  await app.openAgent('other-child');
  expect(app.render().agentBackThreadId).toBe('other');
  await app.render().newSession();
  expect(app.render().agentBackThreadId).toBeNull();
});

test('navigation discards stale paths and truncates loops', () => {
  expect(recordAgentNavigation(['main', 'child'], 'other', 'new-child')).toEqual(['other', 'new-child']);
  expect(recordAgentNavigation(['main', 'child'], 'child', 'main')).toEqual(['main']);
  expect(previousAgentThread(['main', 'child'], 'unrelated')).toBeNull();
});

test('back navigation waits for the refreshed list and blocks duplicate navigation during the lookup', async () => {
  const app = harness();
  await app.render().openSession('main');
  await app.openAgent('child');
  const gate = createDeferred();
  app.waitForList(gate.promise);
  const back = app.render().goBackFromAgent();
  expect(app.render().agentNavigationPending).toBe(true);
  await app.render().goBackFromAgent();
  expect(await app.render().openSession('other')).toBe(false);
  expect(app.calls).toEqual(['pane-a:child']);
  expect(app.requests.slice(-1)).toEqual(['pane-a:list']);
  gate.resolve();
  await back;
  expect(app.render().state.activeSessionId).toBe('main');
});

test('a missing back target is not opened and the current conversation is preserved', async () => {
  const app = harness();
  await app.render().openSession('main');
  await app.openAgent('child');
  app.listOnly(['child']);
  await app.render().goBackFromAgent();
  expect(app.calls).toEqual(['pane-a:child']);
  expect(app.render().state.activeSessionId).toBe('child');
  expect(app.render().state.error).toContain('previous conversation is no longer available');
  expect(app.render().agentNavigationPending).toBe(false);
});

test('a failed list refresh keeps the back target available for retry', async () => {
  const app = harness();
  await app.render().openSession('main');
  await app.openAgent('child');
  app.failList(true);
  await app.render().goBackFromAgent();
  expect(app.calls).toEqual(['pane-a:child']);
  expect(app.render().state.error).toBe('Agent list unavailable');
  expect(app.render().agentBackThreadId).toBe('main');
  expect(app.render().agentNavigationPending).toBe(false);
  app.failList(false);
  await app.render().goBackFromAgent();
  expect(app.render().state.activeSessionId).toBe('main');
});
