import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentProps } from 'react';
import { ChatQuestionProvider } from '../frontend/src/features/chat/ChatInlineQuestion';
import { ChatTimelineHistory } from '../frontend/src/features/chat/ChatTimelineHistory';
import { INITIAL_CHAT_STATE, type ChatTimelineItem } from '../frontend/src/features/chat/model';
import { composerQuestionRequest } from '../frontend/src/features/chat/chatQuestionChoices';
import { questionDismissal, type ChatQuestionDismissal, type ChatQuestionDismissalsApi } from '../shared/chat-question-dismissals';
import type { ChatSendResult } from '../frontend/src/features/chat/chatDraftRecovery';

const question: ChatTimelineItem = { id: 'question', turnId: 'old-turn', kind: 'assistant', createdAt: 1,
  text: 'Raw fallback body must not be repeated', asyncQuestions: [{ title: '만들까요, 아니면 함께 만들까요?', options: ['스킬만', '에이전트도'] }] };
const later: ChatTimelineItem[] = [question,
  { id: 'user-later', turnId: 'new-turn', kind: 'user', text: '다른 오류를 먼저 확인해', createdAt: 2 },
  { id: 'assistant-later', turnId: 'new-turn', kind: 'assistant', text: '수정했습니다.', createdAt: 3 }];
type ProviderProps = ComponentProps<typeof ChatQuestionProvider>;

async function withHistory(run: (view: {
  container: HTMLElement;
  sends: { text: string; delivery: unknown }[];
  records: Map<string, ChatQuestionDismissal[]>;
  render(items?: ChatTimelineItem[], threadId?: string, remount?: boolean): Promise<void>;
  click(label: string, itemId?: string): Promise<void>;
  submit(itemId?: string): Promise<void>;
  setSend(send: () => Promise<ChatSendResult>): void;
}) => Promise<void>) {
  const window = new Window();
  const globals: Record<string, unknown> = {
    window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); };
    const records = new Map<string, ChatQuestionDismissal[]>();
    const persistence: ChatQuestionDismissalsApi = {
      async list(threadId) { return records.get(threadId) ?? []; },
      async save(threadId, value) {
        const record = questionDismissal(value);
        records.set(threadId, [...(records.get(threadId) ?? []).filter(old => old.questionId !== record.questionId), record]);
        return record;
      },
    };
    const sends: { text: string; delivery: unknown }[] = [];
    let send = async (): Promise<ChatSendResult> => ({ status: 'accepted' });
    let providerKey = 0;
    await run({ container, sends, records,
      setSend(value) { send = value; },
      async render(items = later, threadId = 'thread', remount = false) {
        if (remount) providerKey++;
        const state = { ...INITIAL_CHAT_STATE, activeSessionId: threadId, items };
        // Inject the API/controller boundary; use the actual history, question UI, effects and store.
        const controller = { state, loading: false, streaming: false, queueBlocked: false,
          configurationControlsDisabled: false, configurationMenuOpen: false, configurationLoading: false,
          attachmentPickerOpen: false, attachmentTransfer: { loading: false } } as unknown as ProviderProps['controller'];
        const chatController = { state, contextId: 'context', isOperationPending: () => false,
          sendMessage: async (text: string, _skill: unknown, _attachments: unknown, delivery: unknown) => {
            sends.push({ text, delivery }); return send();
          } } as unknown as ProviderProps['chatController'];
        await act(async () => root.render(<ChatQuestionProvider key={providerKey} controller={controller}
          chatController={chatController} active persistence={persistence}>
          <ChatTimelineHistory key={threadId} items={items} timelineRef={{ current: null }} loading={false} streaming={false}
            completedTurns={new Map()} onReviewFileChanges={() => {}} />
        </ChatQuestionProvider>));
      },
      async click(label, itemId = 'question') {
        const row = container.querySelector(`[data-chat-item-id="${itemId}"]`);
        const button = [...(row?.querySelectorAll('button') ?? [])].find(button => button.textContent?.includes(label)
          || button.getAttribute('aria-label') === label);
        expect(button).toBeDefined();
        await act(async () => button!.click());
      },
      async submit(itemId = 'question') {
        const form = container.querySelector(`[data-chat-item-id="${itemId}"] form`);
        expect(form).not.toBeNull();
        await act(async () => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      },
    });
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('old structured questions render at their message position after subsequent user turns, without composer duplicates', async () => {
  await withHistory(async view => {
    await view.render();
    expect(composerQuestionRequest([question], 'thread')).toBeNull();
    expect(composerQuestionRequest(later, 'thread')).toBeNull();
    const rows = [...view.container.querySelectorAll('[data-chat-item-id]')];
    expect(rows.map(row => row.getAttribute('data-chat-item-id'))).toEqual(['question', 'user-later', 'assistant-later']);
    expect(rows[0]?.querySelector('[aria-label="Input requested"]')).not.toBeNull();
    expect(rows[0]?.textContent).toContain('만들까요, 아니면 함께 만들까요?');
    expect(rows[0]?.textContent).not.toContain('Raw fallback body');
    expect(view.container.querySelectorAll('[aria-label="Input requested"]')).toHaveLength(1);
    expect(view.sends).toEqual([]);
    await view.click('에이전트도');
    await view.submit();
    expect(view.sends).toEqual([{ text: '만들까요, 아니면 함께 만들까요?\n에이전트도', delivery: { threadId: 'thread', mode: 'next-turn' } }]);
    expect(rows[0]?.querySelector('[role="status"]')?.textContent).toBe('Answered');
    expect(rows[0]?.querySelector('button[aria-pressed="true"]')?.textContent).toContain('에이전트도');
    expect(rows[0]?.querySelector('button[type="submit"]')).toBeNull();
    await view.render([], 'other');
    await view.render(later, 'thread', true);
    const restored = view.container.querySelector('[data-chat-item-id="question"]');
    expect(restored?.querySelector('[role="status"]')?.textContent).toBe('Answered');
    expect(restored?.querySelector('button[aria-pressed="true"]')?.textContent).toContain('에이전트도');
    await view.submit();
    expect(view.sends).toHaveLength(1);
  });
});

test('closing one old question preserves its closed state without hiding another question', async () => {
  await withHistory(async view => {
    const items = [...later, { ...question, id: 'second', turnId: 'new-turn' }];
    await view.render(items);
    await view.click('Close question');
    expect(view.container.querySelector('[data-chat-item-id="question"] [role="status"]')?.textContent).toBe('Closed');
    expect(view.container.querySelector('[data-chat-item-id="second"] button[type="submit"]')).not.toBeNull();
    await view.render([], 'other');
    await view.render(items, 'thread', true);
    expect(view.container.querySelector('[data-chat-item-id="question"] [role="status"]')?.textContent).toBe('Closed');
    expect(view.container.querySelector('[data-chat-item-id="second"] button[type="submit"]')).not.toBeNull();
    expect(view.sends).toEqual([]);
  });
});

test('an unconfirmed answer remains blocked after its row unmounts and returns', async () => {
  await withHistory(async view => {
    view.setSend(async () => ({ status: 'unknown' }));
    await view.render(); await view.click('스킬만'); await view.submit();
    expect(view.sends).toHaveLength(1);
    await view.render([], 'other'); await view.render();
    expect(view.container.textContent).toContain('Delivery is unconfirmed');
    const submit = view.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    await view.submit();
    expect(view.sends).toHaveLength(1);
  });
});

test('an in-flight answer cannot be submitted again when its history row is remounted', async () => {
  await withHistory(async view => {
    let resolve!: (result: ChatSendResult) => void;
    const pending = new Promise<ChatSendResult>(done => { resolve = done; });
    view.setSend(() => pending);
    await view.render(); await view.click('스킬만'); await view.submit();
    await view.render([], 'other'); await view.render();
    expect(view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await view.submit();
    expect(view.sends).toHaveLength(1);
    await act(async () => resolve({ status: 'accepted' }));
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Answered');
  });
});

test('saved custom answers and selected options with extra details remain readable in completed cards', async () => {
  await withHistory(async view => {
    const saved = { questionId: 'question:["thread","old-turn","question"]', action: 'answered' as const };
    for (const answers of [['스킬만', '이 프로젝트에만 적용'], ['직접 작성한 다른 답변']]) {
      view.records.set('thread', [{ ...saved, answers: { 'answer-1': answers } }]);
      await view.render(later, 'thread', true);
      expect(view.container.querySelector('textarea')?.value).toBe(answers.at(-1)!);
      expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Answered');
      expect(view.container.querySelector('button[type="submit"]')).toBeNull();
    }
    expect(view.sends).toEqual([]);
  });
});
