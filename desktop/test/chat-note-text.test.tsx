import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createChatDraftAttachments, ChatDraftAttachmentsContext } from '../frontend/src/features/chat/chatDraftAttachments';
import { useChatDraft } from '../frontend/src/features/chat/useChatDraft';
import { INITIAL_CHAT_STATE } from '../frontend/src/features/chat/model';
import type { ChatController } from '../frontend/src/features/chat/useChatController';
import type { ChatViewController } from '../frontend/src/features/chat/useChatViewController';
import type { ChatDraftSnapshot } from '../frontend/src/features/chat/chatDraftRecovery';

// Keep the actual view registration, draft store and hook. Isolate services and
// rendering unrelated to adding memo text so no desktop IPC is necessary.
function loadChatView(useController: (options: { controller: ChatController }) => ChatViewController) {
  const url = new URL('../frontend/src/features/chat/ChatView.tsx', import.meta.url);
  const require = createRequire(url);
  const passthrough = ({ children }: { children: ReactNode }) => children;
  const dependencies: Record<string, unknown> = {
    './useChatViewController': { useChatViewController: useController },
    './useChatNotificationVisibility': { useChatNotificationVisibility: () => {} },
    './ChatViewSurface': { ChatViewSurface: passthrough },
    './ChatInlineQuestion': { ChatQuestionProvider: passthrough },
    './AgentActivity': { AgentActivityProvider: passthrough },
    './ChatTurnMetrics': { ChatTurnMetricsProvider: passthrough, latestResponseItemId: () => null },
    './ChatTimeline': { ChatTimeline: () => null },
    './ChatComposer': { ChatComposer: ({ controller, userInputContextId }: {
      controller: ChatViewController; userInputContextId: string;
    }) => <textarea aria-label={userInputContextId} value={controller.draft}
      onChange={event => controller.setDraft(event.target.value)} /> },
  };
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports,
    require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) });
  return (exports as typeof import('../frontend/src/features/chat/ChatView')).ChatView;
}

test('memo text appends in order to the selected draft, preserves other inputs and respects unavailable targets', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const targets = createChatDraftAttachments();
  const stores = new Map<string, ReturnType<typeof useChatDraft>>();
  let fileImports = 0;
  let sends = 0;
  let flags: Partial<ChatViewController> = {};
  let transferring = false;
  const attachment = { kind: 'file' as const, path: '/kept.txt', name: 'kept.txt' };
  const initial: ChatDraftSnapshot = { draft: 'My instructions', selectedSkill: null, attachments: [attachment] };
  const ChatView = loadChatView(({ controller }) => {
    const draft = useChatDraft(controller.sessionRevision, async () => { sends++; return { status: 'accepted' }; },
      controller.contextId === 'a' ? initial : undefined);
    stores.set(controller.contextId!, draft);
    return { ...draft, messageQueue: { total: 0 }, state: controller.state, ...flags,
      attachmentTransfer: { isTransferring: () => transferring, attachFilesToDraft: async () => { fileImports++; return true; } },
    } as unknown as ChatViewController;
  });
  const render = async (revision = 0, includeA = true) => {
    await act(async () => root.render(<ChatDraftAttachmentsContext.Provider value={targets}>
      {(includeA ? ['a', 'b'] : ['b']).map(id => <ChatView key={id} active={false}
        controller={{ contextId: id, sessionRevision: revision, state: INITIAL_CHAT_STATE } as ChatController}
        onNewSession={() => {}} onReviewFileChanges={() => {}} />)}
    </ChatDraftAttachmentsContext.Provider>));
  };
  try {
    await render();
    const first = 'Title one\n  한글\t😀\n';
    const second = 'Title two\nBody';
    await act(async () => {
      // Both operations occur before React renders another view snapshot.
      expect(await Promise.all([targets.appendText('a', first), targets.appendText('a', second)])).toEqual([true, true]);
    });
    expect(stores.get('a')?.draft).toBe(`My instructions\n\n${first}\n\n${second}`);
    expect(stores.get('a')?.attachments).toEqual([attachment]);
    expect(stores.get('b')?.draft).toBe('');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="a"]')?.value).toBe(stores.get('a')?.draft);
    expect(fileImports).toBe(0);
    expect(sends).toBe(0);
    const before = stores.get('a')?.draft;
    expect(await targets.appendText('missing', first)).toBe(false);
    expect(await targets.appendText('a', ' \n')).toBe(false);
    for (const flag of ['interactionsLocked', 'loading', 'sendPending', 'configurationLoading', 'commandLoading',
      'commandMenuOpen', 'attachmentPickerOpen'] as const) {
      flags = { [flag]: true };
      await render();
      expect(await targets.appendText('a', 'Blocked')).toBe(false);
    }
    flags = {};
    transferring = true;
    await render();
    expect(await targets.appendText('a', 'Blocked')).toBe(false);
    expect(stores.get('a')?.draft).toBe(before);
    transferring = false;
    await render(1);
    await act(async () => { expect(await targets.appendText('a', 'New session')).toBe(true); });
    expect(stores.get('a')?.draft).toBe('New session');
    await render(1, false);
    expect(await targets.appendText('a', 'Closed pane')).toBe(false);
    await act(async () => { expect(await targets.appendText('b', 'Other pane')).toBe(true); });
    expect(stores.get('b')?.draft).toBe('Other pane');
    expect(await targets.attach('b', ['/ordinary-file.txt'])).toBe(true);
    expect(fileImports).toBe(1);
  } finally {
    await act(async () => root.unmount());
    expect(await targets.appendText('b', 'Unmounted')).toBe(false);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('disposing an old receiver does not remove its replacement', async () => {
  const targets = createChatDraftAttachments();
  const fileReceiver = async () => true;
  const disposeOld = targets.register('pane', fileReceiver, () => false);
  const received: string[] = [];
  const disposeNew = targets.register('pane', fileReceiver, text => { received.push(text); return true; });
  disposeOld();
  expect(await targets.appendText('pane', 'Current')).toBe(true);
  expect(received).toEqual(['Current']);
  disposeNew();
  expect(await targets.appendText('pane', 'Closed')).toBe(false);
});
