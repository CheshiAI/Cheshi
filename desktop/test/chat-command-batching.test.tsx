import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import type { ChatAction, ChatState } from '../frontend/src/features/chat/model';
import type { useChatController } from '../frontend/src/features/chat/useChatController';

/** Exercise the actual subscription and reducer with a manually advanced browser frame. */
function harness() {
  const slots: unknown[] = [];
  const effects: Array<() => void | (() => void)> = [];
  const cleanups: Array<() => void> = [];
  const frames = new Map<number, FrameRequestCallback>();
  const actions: ChatAction[] = [];
  let cursor = 0, frameId = 0;
  let mounted = false;
  let listener: ((value: unknown) => void) | undefined;
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
      useEffect(effect: () => void | (() => void)) { if (!mounted) effects.push(effect); },
      useReducer(reducer: (state: ChatState, action: ChatAction) => ChatState, initial: ChatState,
        initialize: (state: ChatState) => ChatState) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initialize(initial);
        return [slots[index], (action: ChatAction) => {
          actions.push(action);
          slots[index] = reducer(slots[index] as ChatState, action);
        }];
      },
    },
    '../../cheshiDesktop': { cheshiDesktop: {
      openCodexChatSession: async (id: string) => ({ session: { id, title: id }, items: [] }),
      onCodexChatEvent(callback: (value: unknown) => void) {
        listener = callback;
        return () => { listener = undefined; };
      },
    } },
  };
  const filename = new URL('../frontend/src/features/chat/useChatController.ts', import.meta.url);
  const localRequire = createRequire(filename);
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  vm.runInNewContext(compiled.outputText, { exports, Error,
    require: (name: string) => modules[name] ?? localRequire(name),
    window: {
      requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame(id: number) { frames.delete(id); },
    },
  });
  const hook = exports.useChatController as typeof useChatController;
  const read = () => {
    cursor = 0;
    const controller = hook({ sessionSyncEnabled: false, contextId: 'pane' });
    for (const effect of effects.splice(0)) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    mounted = true;
    return controller;
  };
  return {
    actions, read,
    emit(event: unknown) { listener?.(event); },
    frameCount: () => frames.size,
    subscribed: () => listener !== undefined,
    flush() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); },
    dispose() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); },
  };
}

type Harness = ReturnType<typeof harness>;
function command(id: string, status = 'inProgress', output?: string) {
  return { type: 'activity', threadId: 'thread', item: { id, kind: 'activity', activity: 'command',
    label: 'Command', detail: 'build', status, ...(output === undefined ? {} : { output }) } };
}
const output = (text: string, itemId = 'command', threadId = 'thread') => ({
  type: 'command-output-delta', threadId, itemId, text,
});
function commandOutput(app: Harness, id = 'command') {
  const item = app.read().state.items.find(candidate => candidate.id === id);
  return item?.kind === 'activity' ? item.output : undefined;
}
async function withCommand(run: (app: Harness) => void | Promise<void>) {
  const app = harness();
  try {
    await app.read().openSession('thread');
    app.read();
    app.emit({ type: 'turn-started', threadId: 'thread' });
    app.emit(command('command'));
    app.read();
    app.actions.length = 0;
    await run(app);
  } finally { app.dispose(); }
}

describe('command output frame batching', () => {
  test('one hundred chunks cause one state update and preserve every character', async () => {
    await withCommand(app => {
      const before = app.read().state.items;
      const chunks = Array.from({ length: 100 }, (_, index) => `${index}: 한글 🐱\n`);
      for (const chunk of chunks) app.emit(output(chunk));
      expect(app.frameCount()).toBe(1);
      expect(app.actions).toHaveLength(0);
      expect(app.read().state.items).toBe(before);
      app.flush();
      expect(app.actions).toHaveLength(1);
      expect(app.actions[0]?.type).toBe('events');
      expect(commandOutput(app)).toBe(chunks.join(''));
      app.emit(output('last'));
      app.flush();
      expect(commandOutput(app)).toBe(`${chunks.join('')}last`);
    });
  });

  test('interleaved commands and answer text stay separate and ignore another thread', async () => {
    await withCommand(app => {
      app.emit(command('second'));
      app.actions.length = 0;
      app.emit(output('A'));
      app.emit({ type: 'assistant-delta', threadId: 'thread', itemId: 'answer', text: 'Hello ', createdAt: 1 });
      app.emit(output('B', 'second'));
      app.emit(output('C'));
      app.emit(output('unrelated', 'command', 'other-thread'));
      app.emit({ type: 'assistant-delta', threadId: 'thread', itemId: 'answer', text: 'world', createdAt: 1 });
      app.flush();
      expect(app.actions).toHaveLength(1);
      expect(commandOutput(app)).toBe('AC');
      expect(commandOutput(app, 'second')).toBe('B');
      expect(app.read().state.items.find(item => item.id === 'answer')).toMatchObject({ text: 'Hello world' });
    });
  });

  test('completion flushes pending output before the authoritative final command result', async () => {
    await withCommand(app => {
      app.emit(output('partial'));
      app.emit(command('command', 'completed', 'complete output'));
      expect(app.frameCount()).toBe(0);
      expect(app.actions).toHaveLength(1);
      expect(commandOutput(app)).toBe('complete output');
      app.flush();
      app.emit(output('late chunk'));
      app.flush();
      expect(commandOutput(app)).toBe('complete output');
    });
  });

  test('interruption retains the last chunk even before the queued frame runs', async () => {
    await withCommand(app => {
      app.emit(output('last line\n'));
      app.emit({ type: 'turn-completed', threadId: 'thread', status: 'interrupted' });
      expect(app.frameCount()).toBe(0);
      expect(commandOutput(app)).toBe('last line\n');
      expect(app.read().state.phase).toBe('idle');
      expect(app.read().state.items.find(item => item.id === 'command')).toMatchObject({ status: 'interrupted' });
    });
  });

  test('navigation and disposal cannot apply pending output to another conversation', async () => {
    await withCommand(async app => {
      app.emit(output('old conversation'));
      await app.read().openSession('another');
      app.flush();
      expect(app.read().state.items).toEqual([]);
      app.emit(output('pending', 'new-command', 'another'));
      expect(app.frameCount()).toBe(1);
      app.dispose();
      expect(app.subscribed()).toBe(false);
      expect(app.frameCount()).toBe(0);
      const actions = app.actions.length;
      app.flush();
      expect(app.actions).toHaveLength(actions);
    });
  });
});
