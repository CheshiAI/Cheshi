import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { act, createContext, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { INITIAL_CHAT_STATE } from '../frontend/src/features/chat/model';
import { WORKSPACE_FILE_TRANSFER_TYPE } from '../frontend/src/shared/workspaceFileTransfer';
import type { ChatController } from '../frontend/src/features/chat/useChatController';
import type { ChatViewController } from '../frontend/src/features/chat/useChatViewController';
import type { ChatWorkspaceController } from '../frontend/src/features/chat/useChatWorkspace';
import type { CodexChatAttachment } from '../frontend/src/cheshiDesktop';

function loadModule<T>(filename: string, dependencies: Record<string, unknown>): T {
  const url = new URL(`../frontend/src/features/chat/${filename}`, import.meta.url);
  const require = createRequire(url);
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports, document: globalThis.document, window: globalThis.window,
    require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) });
  return exports as T;
}

// Keep the actual workspace, view, controller, draft store and transfer hook.
// Replace IPC and unrelated rendering; dispatch bubbling DOM events without clicking first.
test('split pane drops and context usage stay scoped to their own conversation', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  const imports: (File | string)[][] = [];
  const pending: ((files: CodexChatAttachment[]) => void)[] = [];
  const controllers = new Map(['first', 'second'].map(contextId => [contextId, {
    contextId, sessionRevision: 0, state: { ...INITIAL_CHAT_STATE }, newSession: noop,
  } as unknown as ChatController]));
  const { useChatViewController } = loadModule<typeof import('../frontend/src/features/chat/useChatViewController')>(
    'useChatViewController.ts', {
      '../../cheshiDesktop': { cheshiDesktop: { importCodexChatAttachments: (files: (File | string)[]) => {
        imports.push(files);
        return new Promise<CodexChatAttachment[]>(resolve => pending.push(resolve));
      } } },
      './useChatConfiguration': { useChatConfiguration: () => ({
        models: [], setConfigurationMenuOpen: noop, setConfigurationMenuView: noop, focusComposer: noop,
      }) },
      './useChatMessageQueue': { useChatMessageQueue: () => ({ entries: [], total: 0 }) },
    });
  const passthrough = ({ children }: { children: ReactNode }) => children;
  const { ChatView } = loadModule<typeof import('../frontend/src/features/chat/ChatView')>('ChatView.tsx', {
    './useChatViewController': { useChatViewController },
    './useChatNotificationVisibility': { useChatNotificationVisibility: noop },
    './ChatViewSurface': { ChatViewSurface: ({ rootRef: _root, timelineRef: _timeline, ...props }:
      HTMLAttributes<HTMLElement> & { rootRef: unknown; timelineRef: unknown }) => <section {...props} /> },
    './ChatInlineQuestion': { ChatQuestionProvider: passthrough },
    './AgentActivity': { AgentActivityProvider: passthrough },
    './ChatTurnMetrics': { ChatTurnMetricsProvider: passthrough, latestResponseItemId: () => null },
    './ChatTimeline': { ChatTimeline: () => <article data-timeline>Answer text</article> },
    './ChatComposer': { ChatComposer: ({ controller }: { controller: ChatViewController }) => <div data-composer>
      <textarea readOnly value={controller.draft} />
      {controller.attachments.map(file => <span data-attachment key={file.path}>{file.path}</span>)}
    </div> },
  });
  const { ChatWorkspace } = loadModule<typeof import('../frontend/src/features/chat/ChatWorkspace')>('ChatWorkspace.tsx', {
    './ChatView': { ChatView },
    './useChatController': { useChatController: ({ contextId }: { contextId: string }) => controllers.get(contextId) },
    './useSavedChatTurns': { useSavedChatTurns: noop, useSavedChatTurnActions: noop },
    './ChatPaneViewport': { ChatPaneViewport: ({ renderPane }: { renderPane: (id: string) => ReactNode }) =>
      <>{renderPane('first')}{renderPane('second')}</> },
    './ChatSavedTurnsSidebar': { ChatSavedTurnsSidebar: () => null },
    './ChatSplitDialog': { ChatSplitDialog: () => null },
    './ChatErrorNotice': { ChatErrorNotice: () => null },
    './ChatPaneIcon': { ChatPaneIcon: () => null },
    '../shell/WorkspaceLayoutControls': { WorkspaceLayoutControls: () => null, WorkspacePaneVisibilityContext: createContext(true) },
    '../../shared/ui': { LiquidGlassPanel: passthrough, NeumorphicButton: () => null, TwoTierHeader: () => null },
    '../../shared/ui/TooltipButton': { TooltipButton: () => null },
    '../../shared/ui/TooltipTarget': { TooltipTarget: ({ content, children }: { content: string; children: ReactNode }) =>
      <div data-context-tooltip={content}>{children}</div> },
    '../../shared/ui/SidebarPanelHeader': { SidebarPanelTitle: () => null },
    './ChatWorkspace.module.css': { default: {} },
    './ChatView.module.css': { default: {} },
  });
  function Fixture({ visible = true, locked = false }: { visible?: boolean; locked?: boolean }) {
    const [activePaneId, selectPane] = useState('first');
    const workspace = {
      activePaneId, selectPane, paneIds: ['first', 'second'], initialSessionIds: {},
      registerController: noop, registerAccountSwitchGuard: noop, accountSwitchPending: locked,
    } as unknown as ChatWorkspaceController;
    return <ChatWorkspace workspace={workspace} active={visible} sessionSyncEnabled={false} onReviewFileChanges={noop} />;
  }
  const pane = (id: string) => container.querySelector<HTMLElement>(`[data-chat-pane="${id}"]`)!;
  const attachmentPaths = (id: string) => [...pane(id).querySelectorAll('[data-attachment]')].map(node => node.textContent);
  const render = async (visible = true, locked = false) => {
    await act(async () => root.render(<Fixture visible={visible} locked={locked} />));
  };
  const drop = async (id: string, selector: string, path: string) => {
    const dataTransfer = { types: [WORKSPACE_FILE_TRANSFER_TYPE], files: [], items: [], dropEffect: 'none',
      getData: () => JSON.stringify([path]) };
    await act(async () => {
      for (const type of ['dragover', 'drop']) {
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
        pane(id).querySelector(selector)!.dispatchEvent(event as unknown as Event);
        expect(event.defaultPrevented).toBe(true);
      }
    });
    return dataTransfer.dropEffect;
  };
  const complete = async (path: string) => {
    const resolve = pending.shift();
    expect(resolve).toBeDefined();
    await act(async () => resolve!([{ kind: 'image', path, name: 'image.png' }]));
  };
  try {
    await render();
    expect(pane('first').dataset.active).toBe('true');
    expect(await drop('second', '[data-timeline]', '/second.png')).toBe('copy');
    expect(pane('second').dataset.active).toBe('true');
    // Repeated events while pending must not start another import.
    expect(await drop('second', 'textarea', '/duplicate.png')).toBe('none');
    // Drop into the other pane before either import completes.
    expect(await drop('first', 'textarea', '/first.png')).toBe('copy');
    expect(pane('first').dataset.active).toBe('true');
    await complete('/saved/second.png');
    expect(attachmentPaths('second')).toEqual(['/saved/second.png']);
    expect(attachmentPaths('first')).toEqual([]);
    await complete('/saved/first.png');
    expect(attachmentPaths('first')).toEqual(['/saved/first.png']);
    expect(pane('second').querySelector('textarea')!.value).toContain('import 1');
    expect(pane('first').querySelector('textarea')!.value).toContain('import 1');
    expect(imports).toEqual([['/second.png'], ['/first.png']]);
    // Changing the target conversation invalidates its outstanding import.
    await drop('second', '[data-timeline]', '/stale.png');
    controllers.set('second', { ...controllers.get('second')!, sessionRevision: 1 });
    await render();
    await complete('/saved/stale.png');
    expect(attachmentPaths('second')).toEqual([]);
    expect(attachmentPaths('first')).toEqual(['/saved/first.png']);
    await render(false);
    expect(await drop('first', '[data-timeline]', '/hidden.png')).toBe('none');
    await render(true, true);
    expect(await drop('first', 'textarea', '/locked.png')).toBe('none');
    expect(imports).toHaveLength(3);
    expect(pane('first').querySelector('[data-context-usage]')?.textContent).toBe('Context —');
    for (const [id, usedTokens] of [['first', 84_000], ['second', 20_000]] as const) {
      const controller = controllers.get(id)!;
      controllers.set(id, { ...controller, state: { ...controller.state, activeSessionId: id,
        contextUsageByThread: { [id]: { usedTokens, contextWindow: 200_000 } } } });
    }
    await render();
    expect(pane('first').querySelector('[data-context-usage]')?.textContent).toBe('Context 42%');
    expect(pane('second').querySelector('[data-context-usage]')?.textContent).toBe('Context 10%');
    expect(pane('first').querySelector('[data-context-tooltip]')?.getAttribute('data-context-tooltip'))
      .toContain('84,000 / 200,000 tokens');
    // Switching to a session with no usage must not retain the previous percentage.
    const first = controllers.get('first')!;
    controllers.set('first', { ...first, state: { ...first.state, activeSessionId: 'unreported' } });
    await render();
    expect(pane('first').querySelector('[data-context-usage]')?.textContent).toBe('Context —');
    expect(pane('second').querySelector('[data-context-usage]')?.textContent).toBe('Context 10%');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
