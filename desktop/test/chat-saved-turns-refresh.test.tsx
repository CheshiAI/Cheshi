import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { ChatSavedTurn, ChatSavedTurnInput } from '../shared/chat-saved-turns';
import type { SavedChatTurnsController } from '../frontend/src/features/chat/useSavedChatTurns';
import { errorMessage } from '../frontend/src/shared/errorMessage';

interface SavedTurnsApi {
  listCodexSavedTurns(): Promise<ChatSavedTurn[]>;
  saveCodexTurn(input: ChatSavedTurnInput): Promise<ChatSavedTurn>;
  deleteCodexSavedTurn(id: string): Promise<{ id: string }>;
}
const compiled = ts.transpileModule(readFileSync(new URL('../frontend/src/features/chat/useSavedChatTurns.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const record = (itemId: string): ChatSavedTurn => ({ id: itemId.repeat(64), itemId, threadId: 'test-thread', sessionTitle: 'Test',
  userText: 'Question', assistantText: 'Answer', createdAt: 1, savedAt: '2026-09-27T00:00:00.000Z' });
const first = record('a');
const second = record('b');

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function withSavedTurns(run: (h: {
  api: SavedTurnsApi;
  current(): SavedChatTurnsController;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const api: SavedTurnsApi = { listCodexSavedTurns: async () => [first], saveCodexTurn: async () => second,
    deleteCodexSavedTurn: async id => ({ id }) };
  const modules: Record<string, unknown> = { react: React, '../../cheshiDesktop': { cheshiDesktop: api }, '../../shared/errorMessage': { errorMessage } };
  const exports: { useSavedChatTurns?: () => SavedChatTurnsController } = {};
  vm.runInNewContext(compiled, { exports, Error, TextEncoder, require: (name: string) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const useSavedTurns = exports.useSavedChatTurns!;
  let controller: SavedChatTurnsController | undefined;
  function Host() { controller = useSavedTurns(); return null; }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(<Host />));
    await run({ api, current: () => {
      if (!controller) throw new Error('Hook not mounted');
      return controller;
    } });
  } finally {
    await React.act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('refresh removes externally deleted records and accepts later external re-saves', async () => {
  await withSavedTurns(async h => {
    expect(h.current().isSaved(first.threadId, first.itemId)).toBe(true);
    h.api.listCodexSavedTurns = async () => [];
    await React.act(async () => h.current().refresh());
    expect(h.current().records).toEqual([]);
    expect(h.current().isSaved(first.threadId, first.itemId)).toBe(false);
    h.api.listCodexSavedTurns = async () => [first];
    await React.act(async () => h.current().refresh());
    expect(h.current().records).toEqual([first]);
    await React.act(async () => { expect(await h.current().remove(first.id)).toBe(true); });
    expect(h.current().records).toEqual([]);
    await React.act(async () => h.current().refresh());
    expect(h.current().records).toEqual([first]);
  });
});

test('an older list response preserves a concurrent save but a subsequent refresh can remove it', async () => {
  await withSavedTurns(async h => {
    const list = createDeferred<ChatSavedTurn[]>();
    h.api.listCodexSavedTurns = () => list.promise;
    let refresh!: Promise<void>;
    await React.act(async () => { refresh = h.current().refresh(); });
    await React.act(async () => { expect(await h.current().save(second)).toBe(true); });
    await React.act(async () => { list.resolve([]); await refresh; });
    expect(h.current().records).toEqual([second]);
    h.api.listCodexSavedTurns = async () => [];
    await React.act(async () => h.current().refresh());
    expect(h.current().records).toEqual([]);
  });
});

test('a save completed after refresh is still appended', async () => {
  await withSavedTurns(async h => {
    const save = createDeferred<ChatSavedTurn>();
    h.api.saveCodexTurn = () => save.promise;
    let saving!: Promise<boolean>;
    await React.act(async () => { saving = h.current().save(second); });
    h.api.listCodexSavedTurns = async () => [];
    await React.act(async () => h.current().refresh());
    expect(h.current().records).toEqual([]);
    await React.act(async () => { save.resolve(second); expect(await saving).toBe(true); });
    expect(h.current().records).toEqual([second]);
  });
});

test('obsolete list responses cannot undo a newer refresh or completed deletion', async () => {
  await withSavedTurns(async h => {
    const older = createDeferred<ChatSavedTurn[]>();
    h.api.listCodexSavedTurns = () => older.promise;
    let refresh!: Promise<void>;
    await React.act(async () => { refresh = h.current().refresh(); });
    h.api.listCodexSavedTurns = async () => [second];
    await React.act(async () => h.current().refresh());
    await React.act(async () => { older.resolve([first]); await refresh; });
    expect(h.current().records).toEqual([second]);
    const stale = createDeferred<ChatSavedTurn[]>();
    h.api.listCodexSavedTurns = () => stale.promise;
    await React.act(async () => { refresh = h.current().refresh(); });
    await React.act(async () => { expect(await h.current().remove(second.id)).toBe(true); });
    await React.act(async () => { stale.resolve([second]); await refresh; });
    expect(h.current().records).toEqual([]);
    expect(h.current().loading).toBe(false);
  });
});

test('a failed refresh preserves existing records and permits retry', async () => {
  await withSavedTurns(async h => {
    h.api.listCodexSavedTurns = async () => { throw new Error('Test read failure'); };
    await React.act(async () => h.current().refresh());
    expect(h.current().records).toEqual([first]);
    expect(h.current().error).toBe('Test read failure');
    h.api.listCodexSavedTurns = async () => [];
    await React.act(async () => h.current().refresh());
    expect(h.current().records).toEqual([]);
    expect(h.current().error).toBeNull();
  });
});
