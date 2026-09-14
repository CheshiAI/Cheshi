import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';

interface TestElement { type: unknown; props: Record<string, unknown> }

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || value === null || !('props' in value)) return [];
  const element = value as TestElement;
  return [element, ...elements(element.props.children)];
}

function renderPane(mainThreadId: string | null, returning = false, locked = false) {
  let returns = 0;
  const jsx = (type: unknown, props: Record<string, unknown>): TestElement => ({ type, props });
  const navigation = { mainThreadId, returning, error: null, returnToMain: async () => { returns++; } };
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      createElement: jsx,
      useCallback: (callback: unknown) => callback,
      useEffect() {}, useLayoutEffect() {},
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initial, () => {}],
    },
    'react-dom': { createPortal: (node: unknown) => node },
    'lucide-react': { ArrowLeft: 'ArrowLeft' },
    '../../../../shared/chat-relay': { chatRelayContextIds: () => [] },
    '../../shared/ui': { LiquidGlassPanel: 'Panel', NeumorphicButton: 'Button', TwoTierHeader: 'Header' },
    '../../shared/ui/SplitPaneLayout': {},
    './ChatView': { ChatView: 'ChatView' },
    './ChatErrorNotice': { ChatErrorNotice: 'ErrorNotice' },
    './ChatPaneIcon': { ChatPaneIcon: 'PaneIcon' },
    './ChatRelayControls': {}, './ChatRelayHistoryPanel': {}, './ChatSplitDialog': {},
    './useChatController': { useChatController: () => ({
      state: { activeSessionId: 'viewed', phase: 'idle', sessions: [] }, configurationPending: false,
    }) },
    './useChatAgentNavigation': { useChatAgentNavigation: () => navigation },
    './ChatView.module.css': { default: {} },
    './ChatWorkspace.module.css': { default: { paneHeading: 'paneHeading', paneTitle: 'paneTitle' } },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/ChatWorkspace.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, document: { createElement: () => ({}) }, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const render = exports.ChatWorkspace;
  assert.ok(typeof render === 'function');
  const tree = render({ workspace: {
    paneIds: ['pane'], initialSessionIds: {}, activePaneId: 'pane',
    relay: { running: false }, accountSwitchPending: locked,
  } });
  const pane = elements(tree).find(element => element.props.paneId === 'pane');
  assert.ok(pane && typeof pane.type === 'function');
  return { tree: pane.type(pane.props), get returns() { return returns; } };
}

test('subagent header places the circular back button before the session id and routes its click', () => {
  const pane = renderPane('main');
  const heading = elements(pane.tree).find(element => element.props.className === 'paneHeading');
  assert.ok(heading);
  const buttons = elements(heading);
  const back = buttons.find(element => element.props['aria-label'] === 'Back to main agent');
  const title = buttons.find(element => element.props.className === 'paneTitle');
  assert.ok(back && title);
  expect(buttons.indexOf(back)).toBeLessThan(buttons.indexOf(title));
  expect(back.props).toMatchObject({ raised: true, size: 'icon', disabled: false });
  assert.ok(typeof back.props.onClick === 'function');
  back.props.onClick();
  expect(pane.returns).toBe(1);
});

test('main conversations hide the button and returning or locked panes disable it', () => {
  expect(elements(renderPane(null).tree).some(element => element.props['aria-label'] === 'Back to main agent')).toBe(false);
  for (const [returning, locked] of [[true, false], [false, true]]) {
    const back = elements(renderPane('main', returning, locked).tree)
      .find(element => element.props['aria-label'] === 'Back to main agent');
    expect(back?.props.disabled).toBe(true);
  }
});
