import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { act, Fragment, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Window, type HTMLElement as TestElement, type HTMLButtonElement as TestButton } from 'happy-dom';
import { INITIAL_CHAT_STATE } from '../frontend/src/features/chat/model';
import type { ChatController } from '../frontend/src/features/chat/useChatController';

// Isolate unrelated composer services without replacing React or the scroll implementation.
function loadModule<T>(filename: string, dependencies: Record<string, unknown>): T {
  const url = new URL(`../frontend/src/features/chat/${filename}`, import.meta.url);
  const require = createRequire(url);
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports,
    require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
  });
  return exports as T;
}

const noop = () => {};
const { useChatViewController } = loadModule<typeof import('../frontend/src/features/chat/useChatViewController')>(
  'useChatViewController.ts', {
    '../../cheshiDesktop': { cheshiDesktop: undefined },
    './useChatConfiguration': { useChatConfiguration: () => ({
      models: [], setConfigurationMenuOpen: noop, setConfigurationMenuView: noop,
    }) },
    './useChatDraft': { useChatDraft: () => ({ draft: '', attachments: [] }) },
    './useChatAttachmentTransfer': { useChatAttachmentTransfer: () => ({ loading: false }) },
    './useChatMessageQueue': { useChatMessageQueue: () => ({ entries: [] }) },
  },
);
const { ChatTimeline } = loadModule<typeof import('../frontend/src/features/chat/ChatTimeline')>('ChatTimeline.tsx', {
  '../../shared/ui': { NeumorphicButton: ({ raised: _raised, ...props }: Record<string, unknown>) => <button {...props} /> },
  './ChatTimelineHistory': { ChatTimelineHistory: () => null },
  './ChatWelcome': { ChatWelcome: () => null },
  './ChatErrorNotice': { ChatErrorNotice: () => null },
  './ChatView.module.css': { default: {} },
});

function Fixture({ threadId, contextId }: { threadId: string | null; contextId: string }) {
  const chatController = useMemo(() => ({
    contextId, sessionRevision: 0,
    state: { ...INITIAL_CHAT_STATE, activeSessionId: threadId, items: [
      { id: 'answer', kind: 'assistant', text: 'Answer', createdAt: 1 },
    ] },
  } as ChatController), [threadId, contextId]);
  const controller = useChatViewController({ onNewSession: noop, controller: chatController });
  // ChatView keys its providers with this identity, remounting the timeline but retaining the controller.
  return <Fragment key={`${contextId}:${threadId}`}>
    <ChatTimeline controller={controller} onReviewFileChanges={noop} />
  </Fragment>;
}

async function withTimeline(run: (harness: {
  render: (threadId: string | null, contextId?: string) => Promise<void>;
  timeline: () => TestElement;
  button: () => TestButton | null;
  scroll: (element: TestElement, top: number) => Promise<void>;
  scrolls: ScrollToOptions[];
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const scrolls: ScrollToOptions[] = [];
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: { configurable: true, get: () => 1600 },
    clientHeight: { configurable: true, get: () => 600 },
    scrollTo: { configurable: true, value(this: TestElement, options: ScrollToOptions) {
      scrolls.push(options);
      this.scrollTop = Math.min(options.top ?? this.scrollTop, 1000);
      this.dispatchEvent(new window.Event('scroll'));
    } },
  });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await run({
      render: async (threadId, contextId = 'pane-one') => {
        await act(async () => root.render(<Fixture threadId={threadId} contextId={contextId} />));
      },
      timeline: () => container.querySelector<TestElement>('[aria-label="Conversation"]')!,
      button: () => container.querySelector<TestButton>('[aria-label="Scroll to latest message"]'),
      scroll: async (element, top) => {
        await act(async () => {
          element.scrollTop = top;
          element.dispatchEvent(new window.Event('scroll'));
        });
      },
      scrolls,
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('scroll arrow follows the new timeline after selecting and creating conversations', async () => {
  await withTimeline(async h => {
    await h.render('first');
    expect(Boolean(h.button())).toBe(false);
    await h.scroll(h.timeline(), 300);
    expect(Boolean(h.button())).toBe(true);
    for (const thread of ['second', null, 'created']) {
      const oldTimeline = h.timeline();
      await h.render(thread);
      expect(h.timeline() === oldTimeline).toBe(false);
      expect(Boolean(h.button())).toBe(false);
      await h.scroll(oldTimeline, 100);
      expect(Boolean(h.button())).toBe(false);
      await h.scroll(h.timeline(), 300);
      expect(Boolean(h.button())).toBe(true);
      await act(async () => h.button()!.click());
      expect(h.scrolls.at(-1)).toEqual({ top: 1600, behavior: 'smooth' });
      expect(h.timeline().scrollTop).toBe(1000);
      expect(Boolean(h.button())).toBe(false);
    }
  });
});

test('scroll arrow tracks a replacement chat context with the same conversation', async () => {
  await withTimeline(async h => {
    await h.render('thread', 'pane-one');
    const oldTimeline = h.timeline();
    await h.render('thread', 'pane-two');
    expect(h.timeline() === oldTimeline).toBe(false);
    await h.scroll(h.timeline(), 300);
    expect(Boolean(h.button())).toBe(true);
    await h.scroll(h.timeline(), 960);
    expect(Boolean(h.button())).toBe(false);
  });
});
