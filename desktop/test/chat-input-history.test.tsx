import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import type { KeyboardEvent } from 'react';
import ts from 'typescript';
import { createChatInputHistory, handleInputHistoryKey } from '../frontend/src/features/chat/chatInputHistory';
import type { ChatTimelineItem } from '../frontend/src/features/chat/model';
import type { useChatInputHistory } from '../frontend/src/features/chat/useChatInputHistory';
import type { ChatInputHistoryPanel } from '../frontend/src/features/chat/ChatInputHistoryPanel';

const question = (text: string, id = text) => ({ id, kind: 'user' as const, text, createdAt: 1 });
const items = [question('First'), question('Second\nline')];
function key(name: string, overrides: { repeat?: boolean; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number } } = {}) {
  let prevented = false;
  let stopped = false;
  const event = { key: name, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; }, ...overrides } as KeyboardEvent<HTMLTextAreaElement>;
  return { event, prevented: () => prevented, stopped: () => stopped };
}

test('lists newest questions first and selection returns exact text once without sending', () => {
  const store = createChatInputHistory();
  expect(store.open('a', items)).toBe(true);
  expect(store.getSnapshot().entries.map(entry => entry.text)).toEqual(['Second\nline', 'First']);
  store.move(1); expect(store.getSnapshot().selected).toBe(1);
  store.move(1); expect(store.getSnapshot().selected).toBe(1);
  store.move(-1); expect(store.getSnapshot().selected).toBe(0);
  expect(store.take('a')).toBe('Second\nline');
  expect(store.take('a')).toBeNull();
  expect(store.getSnapshot().entries).toEqual([]);
});

test('filters non-user and unconfirmed messages while preserving duplicate questions and whitespace', () => {
  const store = createChatInputHistory();
  const mixed: ChatTimelineItem[] = [question('  text\n  ', '1'), question('  text\n  ', '2'),
    { ...question('pending'), pending: true }, { ...question('failed'), delivery: 'failed' },
    { ...question('unknown'), delivery: 'unknown' }, { id: 'answer', kind: 'assistant', text: 'Answer', createdAt: 2 }, question('  ')];
  store.open('a', mixed);
  expect(store.getSnapshot().entries).toEqual([{ id: '2', text: '  text\n  ' }, { id: '1', text: '  text\n  ' }]);
  expect(store.take('other')).toBeNull();
  expect(store.open('empty', [])).toBe(false);
});

test('browsing is a stable snapshot and closing does not insert anything', () => {
  const store = createChatInputHistory();
  let updates = 0;
  const unsubscribe = store.subscribe(() => { updates++; });
  const source = [...items]; store.open('a', source); source.push(question('Third'));
  expect(store.getSnapshot().entries).toHaveLength(2);
  store.highlight(1); expect(store.getSnapshot().selected).toBe(1);
  store.highlight(99); expect(store.getSnapshot().selected).toBe(1);
  store.close(); expect(store.take('a')).toBeNull();
  unsubscribe(); const before = updates;
  store.open('a', source); expect(updates).toBe(before);
  expect(store.getSnapshot().entries[0]?.text).toBe('Third');
});

function load<T>(file: string, name: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const source = readFileSync(new URL(`../frontend/src/features/chat/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, ...globals, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name];
  } });
  return exports[name] as T;
}

function harness() {
  let refCursor = 0; let effectCursor = 0;
  const refs: { current: unknown }[] = [];
  const effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const pending: (() => void)[] = [];
  const store = createChatInputHistory();
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  class Target {}
  let focused = 0;
  const textarea = Object.assign(new Target(), { contains: (target: unknown) => target === textarea,
    focus: () => { focused++; }, setSelectionRange: (start: number, end: number) => { selection = [start, end]; } });
  let selection: number[] = [];
  const textareaRef = { current: textarea as unknown as HTMLTextAreaElement };
  let draft = ''; let scope = 'a'; let disabled = false; let forwarded = 0;
  const effect = (run: () => void | (() => void), deps: unknown[]) => {
    const index = effectCursor++; const old = effects[index];
    if (old && old.deps.length === deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
    effects[index] = { deps };
    pending.push(() => { old?.cleanup?.(); const cleanup = run(); if (cleanup) effects[index]!.cleanup = cleanup; });
  };
  const hook = load<typeof useChatInputHistory>('useChatInputHistory.ts', 'useChatInputHistory', {
    react: { useMemo: () => store, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
      useRef: (value: unknown) => refs[refCursor++] ??= { current: value }, useId: () => 'history', useEffect: effect, useLayoutEffect: effect },
    './chatInputHistory': { createChatInputHistory, handleInputHistoryKey },
  }, { Node: Target, document: {
    addEventListener: (name: string, listener: (event: { target: unknown }) => void) => { listeners.set(name, listener); },
    removeEventListener: (name: string) => { listeners.delete(name); },
  } });
  const render = () => {
    refCursor = 0; effectCursor = 0;
    const result = hook({ scope, items, draft, disabled, textareaRef, setDraft: value => { draft = value; },
      onKeyDown: () => { forwarded++; } });
    pending.splice(0).forEach(run => run());
    return result;
  };
  return { render, textarea, get draft() { return draft; }, get forwarded() { return forwarded; },
    get focused() { return focused; }, get selection() { return selection; }, get listeners() { return listeners.size; },
    change(value: string) { draft = value; }, switchScope(value: string) { scope = value; }, disable() { disabled = true; },
    pointer(target: unknown = new Target()) { listeners.get('pointerdown')?.({ target }); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); } };
}

test('opening and navigating do not edit the draft; Enter selects, keeps focus and never submits', () => {
  const app = harness();
  const up = key('ArrowUp'); app.render().onKeyDown(up.event);
  expect(up.prevented()).toBe(true); expect(app.draft).toBe('');
  expect(app.render().open).toBe(true);
  app.render().onKeyDown(key('ArrowDown').event);
  expect(app.render().state.selected).toBe(1); expect(app.draft).toBe('');
  const enter = key('Enter'); app.render().onKeyDown(enter.event);
  expect(enter.prevented()).toBe(true); expect(enter.stopped()).toBe(true);
  expect(app.draft).toBe('First'); expect(app.render().open).toBe(false);
  expect(app.selection).toEqual([5, 5]); expect(app.focused).toBe(1);
  app.render().onKeyDown(key('Enter', { repeat: true }).event);
  expect(app.forwarded).toBe(0);
  app.render().onKeyUp(key('Enter').event);
  app.render().onKeyDown(key('Enter').event);
  expect(app.forwarded).toBe(1);
});

test('click selection, Escape, outside clicks and close preserve the input and clean up listeners', () => {
  const app = harness(); app.render().onKeyDown(key('ArrowUp').event);
  app.render(); app.pointer(app.textarea); expect(app.render().open).toBe(true);
  app.pointer(); expect(app.render().open).toBe(false); expect(app.draft).toBe('');
  app.render().onKeyDown(key('ArrowUp').event);
  const escape = key('Escape'); app.render().onKeyDown(escape.event);
  expect(escape.stopped()).toBe(true); expect(app.draft).toBe('');
  app.render().onKeyDown(key('ArrowUp').event); app.render().dismiss();
  expect(app.render().open).toBe(false);
  app.render().onKeyDown(key('ArrowUp').event); app.render().select(0);
  expect(app.draft).toBe('Second\nline'); expect(app.forwarded).toBe(0);
  app.unmount(); expect(app.listeners).toBe(0);
});

test('editing, switching sessions or opening another menu closes history; ordinary typing and IME retain their behavior', () => {
  const app = harness(); app.render().onKeyDown(key('ArrowUp').event);
  app.change('typed'); expect(app.render().open).toBe(false);
  app.render().onKeyDown(key('ArrowUp').event); expect(app.draft).toBe('typed');
  app.change(''); app.render().onKeyDown(key('ArrowUp').event);
  app.switchScope('b'); expect(app.render().open).toBe(false);
  app.render().onKeyDown(key('ArrowUp', { nativeEvent: { isComposing: true } }).event);
  expect(app.render().open).toBe(false);
  app.render().onKeyDown(key('ArrowUp', { nativeEvent: { keyCode: 229 } }).event);
  expect(app.render().open).toBe(false);
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) {
    app.render().onKeyDown(key('ArrowUp', { [modifier]: true }).event); expect(app.render().open).toBe(false);
  }
  app.render().onKeyDown(key('ArrowUp').event); expect(app.render().open).toBe(true);
  app.disable(); expect(app.render().open).toBe(false);
  app.render().onKeyDown(key('ArrowUp').event); expect(app.render().open).toBe(false);
  app.unmount();
});

interface Element { type: unknown; props: Record<string, unknown> }
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}

test('the panel exposes selectable questions, a close action and keyboard help', () => {
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const component = load<typeof ChatInputHistoryPanel>('ChatInputHistoryPanel.tsx', 'ChatInputHistoryPanel', {
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': { MessageSquareText: 'Message', X: 'X' },
    '../../shared/ui': { LiquidGlassPanel: 'Panel', NeumorphicButton: 'Button' },
    './ChatView.module.css': { default: {} }, './ChatInputHistory.module.css': { default: {} },
  });
  const app = harness(); expect(component({ history: app.render() })).toBeNull();
  app.render().onKeyDown(key('ArrowUp').event);
  const tree = component({ history: app.render() }); const nodes = elements(tree);
  expect(nodes.some(node => node.props.role === 'listbox')).toBe(true);
  const options = nodes.filter(node => node.props.role === 'option');
  expect(options).toHaveLength(2); expect(options[0]?.props['aria-selected']).toBe(true);
  expect(options[0]?.props.title).toBe('Second\nline');
  const click = options[1]?.props.onClick; assert.ok(typeof click === 'function'); click();
  expect(app.draft).toBe('First'); expect(app.forwarded).toBe(0);
  expect(nodes.some(node => node.props['aria-label'] === 'Close input history')).toBe(true);
  const close = nodes.find(node => node.props['aria-label'] === 'Close input history');
  assert.ok(typeof close?.props.onKeyDown === 'function');
  const enter = key('Enter'); close.props.onKeyDown(enter.event);
  expect(enter.stopped()).toBe(true); expect(enter.prevented()).toBe(false);
  expect(nodes.some(node => node.props.children === '↑↓ Navigate · Enter Select · Esc Close')).toBe(true);
  app.unmount();
});
