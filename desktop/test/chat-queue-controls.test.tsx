import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { ChatQueueController } from '../frontend/src/features/chat/ChatMessageQueue';

interface Element { type: unknown; props: Record<string, unknown> }
function harness() {
  let menuTarget: unknown = null;
  let open = true;
  const calls: string[] = [];
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
  const modules: Record<string, unknown> = {
    react: { useState: () => [menuTarget, (value: unknown) => { menuTarget = value; }],
      useEffect: (effect: () => void) => effect(),
      useCallback: (callback: unknown) => callback, useRef: () => ({ current: null }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: (element: Element) => element },
    'lucide-react': Object.fromEntries(['CornerDownRight', 'ListEnd', 'MessageCirclePlus', 'MoreHorizontal', 'Pause', 'Pencil', 'Play', 'Trash2'].map(name => [name, name])),
    '../../shared/ui': { LiquidGlassPanel: 'section', NeumorphicButton: 'button', NeumorphicSurface: 'span' },
    '../../shared/ui/contextMenuInteractions': { focusAdjacentMenuItem() {}, useContextMenuInteractions() {} },
    '../../shared/useHelpLanguage': { useHelpLanguage: () => ['ko'] },
    './ChatMessageQueue.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/ChatMessageQueue.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: Record<string, (props: { controller: ChatQueueController; open: boolean; panelId: string; onToggle?: () => void }) => Element | null> = {};
  vm.runInNewContext(compiled.outputText, { exports, document: { body: {} }, window: { innerWidth: 900, innerHeight: 700 },
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; } });
  // This rendering boundary supplies only fields used by the queue controls.
  const controller: ChatQueueController = { streaming: true, loading: false, queueBlocked: false, interactionsLocked: false,
    commandMenuOpen: false, canOpenSideChat: true, draft: '', attachments: [], selectedSkill: null, sendRecovery: null,
    editQueuedMessage: (id: string) => { calls.push(`edit:${id}`); },
    openQueuedSideChat: (id: string) => { calls.push(`side:${id}`); },
    messageQueue: { paused: false, entries: [{ id: 'one', threadId: 'a', status: 'queued',
      input: { draft: '다음 요청', selectedSkill: null, attachments: [] } }],
      steer: async (id: string) => { calls.push(`steer:${id}`); return true; },
      remove: (id: string) => { calls.push(`remove:${id}`); }, toggleCurrent: () => { calls.push('toggle'); },
    },
  };
  function elements(value: unknown): Element[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value || typeof value !== 'object' || !('props' in value)) return [];
    const element = value as Element;
    if (typeof element.type === 'function') return elements(element.type(element.props));
    return [element, ...elements(element.props.children)];
  }
  const render = () => [
    ...elements(exports.ChatMessageQueue!({ controller, open, panelId: 'queue-panel' })),
    ...elements(exports.ChatQueueToggle!({ controller, open, panelId: 'queue-panel', onToggle: () => { open = !open; } })),
  ];
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(text).join('');
    return value && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : '';
  };
  const button = (label: string) => {
    const result = render().find(element => element.type === 'button'
      && (element.props['aria-label'] === label || text(element.props.children) === label));
    assert.ok(result, `Missing button: ${label}`); return result;
  };
  const click = (label: string) => {
    const target = button(label);
    assert.notEqual(target.props.disabled, true);
    assert.ok(typeof target.props.onClick === 'function');
    target.props.onClick({ currentTarget: { focus() {}, getBoundingClientRect: () => ({ right: 500, bottom: 300 }) } });
  };
  return { controller, calls, render, click, button };
}

test('queue card and more menu invoke steer, delete, edit, side chat, and queue toggle', () => {
  const app = harness();
  app.click('현재 작업 조정'); app.click('대기 메시지 삭제');
  for (const label of ['메시지 편집', '사이드 채팅에서 열기', '대기열 끄기']) {
    app.click('대기 메시지 더보기');
    expect(app.button('대기 메시지 더보기').props['aria-expanded']).toBe(true);
    app.click(label);
  }
  expect(app.calls).toEqual(['steer:one', 'remove:one', 'edit:one', 'side:one', 'toggle']);
  app.controller.messageQueue.paused = true;
  expect(app.button('대기열 켜기').props['aria-pressed']).toBe(false);
});

test('editing never overwrites a current draft and unavailable side chat stays disabled', () => {
  const app = harness(); app.controller.draft = '작성 중'; app.controller.canOpenSideChat = false;
  app.click('대기 메시지 더보기');
  expect(app.button('메시지 편집').props.disabled).toBe(true);
  expect(app.button('사이드 채팅에서 열기').props.disabled).toBe(true);
  expect(app.calls).toEqual([]);
});

test('sending rows cannot be edited or deleted and uncertain delivery cannot be steered', () => {
  const app = harness(); app.controller.messageQueue.entries[0]!.status = 'sending';
  expect(app.button('현재 작업 조정').props.disabled).toBe(true);
  expect(app.button('대기 메시지 삭제').props.disabled).toBe(true);
  expect(app.button('대기 메시지 더보기').props.disabled).toBe(true);
  app.controller.messageQueue.entries[0]!.status = 'unknown';
  expect(app.button('현재 작업 조정').props.disabled).toBe(true);
});


test('visibility toggle only requires queued messages, even with an empty or blocked draft', () => {
  const app = harness();
  app.controller.draft = '';
  app.controller.queueBlocked = true;
  app.controller.streaming = false;
  expect(app.button('대기열').props.disabled).toBe(false);
  expect(app.button('대기열').props['aria-pressed']).toBe(true);
  expect(app.button('대기열').props['aria-controls']).toBe('queue-panel');
  app.controller.messageQueue.entries = [];
  expect(app.button('대기열').props.disabled).toBe(true);
  expect(app.button('대기열').props['aria-pressed']).toBe(false);
  expect(app.render()[0]!.props.inert).toBe(true);
});

test('turning visibility off retains messages and automatic sending while making the panel inert', () => {
  const app = harness();
  app.click('대기열');
  expect(app.button('대기열').props['aria-expanded']).toBe(false);
  expect(app.render()[0]!.props).toMatchObject({ id: 'queue-panel', 'data-open': 'false', 'aria-hidden': true, inert: true });
  expect(app.render().some(element => element.props.title === '다음 요청')).toBe(true);
  expect(app.controller.messageQueue.entries).toHaveLength(1);
  expect(app.controller.messageQueue.paused).toBe(false);
  expect(app.calls).toEqual([]);
  app.click('대기열');
  expect(app.button('대기열').props['aria-pressed']).toBe(true);
  expect(app.render()[0]!.props).toMatchObject({ 'data-open': 'true', 'aria-hidden': false, inert: false });
});

test('collapsing dismisses the portaled menu and does not reopen it on expansion', () => {
  const app = harness(); app.click('대기 메시지 더보기');
  expect(app.render().some(element => element.props.role === 'menu')).toBe(true);
  app.click('대기열');
  expect(app.render().some(element => element.props.role === 'menu')).toBe(false);
  app.click('대기열');
  expect(app.render().some(element => element.props.role === 'menu')).toBe(false);
});


test('Escape closes the queued-message menu and consumes the event before chat cancellation', () => {
  const app = harness(); app.click('대기 메시지 더보기');
  const handleKeyDown = app.render()[0]!.props.onKeyDown;
  assert.ok(typeof handleKeyDown === 'function');
  let prevented = false;
  let stopped = false;
  handleKeyDown({ key: 'Escape', nativeEvent: { isComposing: false },
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  expect(prevented).toBe(true);
  expect(stopped).toBe(true);
  expect(app.render().some(element => element.props.role === 'menu')).toBe(false);
  expect(app.calls).toEqual([]);
});
