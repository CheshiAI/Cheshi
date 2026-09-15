import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import { cancelChatSend, createChatSendCompletion, type ChatSendAttempt } from '../frontend/src/features/chat/chatSendAttempt';
import { createChatDraftRecovery, type ChatDraftSnapshot } from '../frontend/src/features/chat/chatDraftRecovery';
import { createChatMessageQueue } from '../frontend/src/features/chat/chatMessageQueueStore';
import { INITIAL_CHAT_STATE, isViewedSessionResponding, normalizeChatEvent } from '../frontend/src/features/chat/model';
import type { ChatController } from '../frontend/src/features/chat/useChatController';
import type { useChatDraft } from '../frontend/src/features/chat/useChatDraft';
import type { useChatMessageQueue } from '../frontend/src/features/chat/useChatMessageQueue';

function hooks() {
  let refIndex = 0;
  let effectIndex = 0;
  const refs: { current: unknown }[] = [];
  const effects: { run: () => void | (() => void); deps?: unknown[]; cleanup?: void | (() => void) }[] = [];
  const pending: (() => void)[] = [];
  function effect(run: () => void | (() => void), deps?: unknown[]) {
    const index = effectIndex++;
    const old = effects[index];
    if (old && deps && old.deps?.length === deps.length && deps.every((dep, i) => Object.is(dep, old.deps![i]))) return;
    effects[index] = { run, deps };
    pending.push(() => { old?.cleanup?.(); effects[index]!.cleanup = run(); });
  }
  return {
    react: {
      useRef(value: unknown) { const index = refIndex++; return refs[index] ??= { current: value }; },
      useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot(); },
      useLayoutEffect: effect, useEffect: effect,
    },
    render<T>(run: () => T) { refIndex = 0; effectIndex = 0; const value = run(); pending.splice(0).forEach(fn => fn()); return value; },
    replayEffects() { effects.forEach(effect => effect.cleanup?.()); effects.forEach(effect => { effect.cleanup = effect.run(); }); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}
function load<T>(filename: string, exportName: string, modules: Record<string, unknown>): T {
  const source = readFileSync(new URL(`../frontend/src/features/chat/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  } });
  return exports[exportName] as T;
}

test('side-chat draft survives Strict Mode replay, then never reappears in another session', () => {
  const app = hooks();
  const hook = load<typeof useChatDraft>('useChatDraft.ts', 'useChatDraft', {
    react: app.react, './chatDraftRecovery': { createChatDraftRecovery },
  });
  const original: ChatDraftSnapshot = { draft: 'Side chat', selectedSkill: null,
    attachments: [{ kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' }] };
  const render = (revision = 0) => app.render(() => hook(revision, async () => ({ status: 'accepted' }), original));
  render(); app.replayEffects();
  expect(render()).toMatchObject(original);
  render().setDraft('Edited');
  expect(render().draft).toBe('Edited');
  render(1);
  expect(render(1)).toMatchObject({ draft: '', attachments: [] });
});

test('queue subscribes to its pane, drains through real normalized completion events, and unsubscribes', async () => {
  const app = hooks();
  const subscriptions = new Map<string | undefined, (value: unknown) => void>();
  const hook = load<typeof useChatMessageQueue>('useChatMessageQueue.ts', 'useChatMessageQueue', {
    react: app.react, './chatMessageQueueStore': { createChatMessageQueue },
    './model': { isViewedSessionResponding, normalizeChatEvent },
    '../../cheshiDesktop': { cheshiDesktop: {
      onCodexChatEvent(handler: (value: unknown) => void, contextId?: string) {
        subscriptions.set(contextId, handler); return () => { subscriptions.delete(contextId); };
      },
    } },
  });
  const sent: string[] = [];
  // Only the queue's documented controller boundary is needed by this hook.
  const controller = { contextId: 'pane-a', configurationPending: false,
    state: { ...INITIAL_CHAT_STATE, activeSessionId: 'thread-a', responseThreadIds: ['thread-a'] },
    sendMessage: async (text: string) => { sent.push(text); return { status: 'accepted' as const }; },
  } as ChatController;
  const render = () => app.render(() => hook(controller, false));
  let queue = render(); app.replayEffects(); queue = render();
  expect([...subscriptions.keys()]).toEqual(['pane-a']);
  queue.enqueue({ draft: 'first', selectedSkill: null, attachments: [] });
  queue.enqueue({ draft: 'second', selectedSkill: null, attachments: [] });
  const complete = () => subscriptions.get('pane-a')!({ type: 'turn-completed', threadId: 'thread-a', status: 'completed' });
  complete(); controller.state.responseThreadIds = []; render();
  for (let index = 0; index < 4; index++) await Promise.resolve();
  render(); expect(sent).toEqual(['first']);
  controller.state.responseThreadIds = ['thread-a']; render();
  complete(); controller.state.responseThreadIds = []; render();
  expect(sent).toEqual(['first', 'second']);
  app.unmount(); expect(subscriptions.size).toBe(0);
});


test('cancellation interrupts immediately and again after an already-starting send resolves its thread', async () => {
  const completion = createChatSendCompletion();
  const attempt: ChatSendAttempt = { clientMessageId: 'message', threadId: null, accepted: false };
  const stopped: (string | null)[] = [];
  const result = cancelChatSend(null, async (threadId) => { stopped.push(threadId); }, { attempt, settled: completion.settled });
  expect(stopped).toEqual([null]);
  attempt.threadId = 'started-thread'; attempt.accepted = true;
  completion.finish(); await result;
  expect(stopped).toEqual([null, 'started-thread']);
});

test('a failed early interruption still retries after the pending send settles', async () => {
  const completion = createChatSendCompletion();
  const attempt: ChatSendAttempt = { clientMessageId: 'message', threadId: 'a', accepted: true };
  let calls = 0;
  const result = cancelChatSend('a', async () => { if (++calls === 1) throw new Error('Starting'); }, { attempt, settled: completion.settled });
  completion.finish(); await result;
  expect(calls).toBe(2);
});

test('a final interruption error propagates for the controller to display', async () => {
  let failure: unknown;
  try { await cancelChatSend('a', async () => { throw new Error('Interrupt failed'); }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Interrupt failed');
});
