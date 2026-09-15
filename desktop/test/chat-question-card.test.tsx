import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { ChatUserInputRequest, ChatUserInputResponse } from '../shared/chat-user-input';
import type { ChatSendResult } from '../frontend/src/features/chat/chatDraftRecovery';
import { fallbackQuestionRequest, plainTextQuestion } from '../frontend/src/features/chat/chatQuestionChoices';
import { createFallbackQuestionStore } from '../frontend/src/features/chat/chatFallbackQuestionStore';
import { initialInputDraft, inputResponse, userInputLink } from '../frontend/src/features/chat/chatUserInputForm';

const text = '어떤 과일을 고르시겠어요?\n\n1. 사과\n2. 딸기';
const request = fallbackQuestionRequest([{ id: 'question', kind: 'assistant', createdAt: 1, text }], 'thread')!;
const answer: ChatUserInputResponse = { action: 'accept', answers: { answer: ['사과', '추가 설명'] } };
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('recognizes a final Korean or English choice question and ignores answered conversations', () => {
  expect(plainTextQuestion(text)).toEqual({ question: '어떤 과일을 고르시겠어요?', options: ['사과', '딸기'] });
  expect(plainTextQuestion('Which fruit?\r\n\r\n1. **Apple**\r\n\r\n2. `Strawberry`')?.options).toEqual(['Apple', 'Strawberry']);
  expect(fallbackQuestionRequest([{ id: 'question', kind: 'assistant', createdAt: 1, text },
    { id: 'answer', kind: 'user', createdAt: 2, text: '사과' }], 'thread')).toBeNull();
  expect(fallbackQuestionRequest([], null)).toBeNull();
});

test.each(['-', '*', '+', '•'])('recognizes flat %s choices followed by a separate notice in the same turn', marker => {
  const result = fallbackQuestionRequest([
    { id: 'user', kind: 'user', createdAt: 1, text: '선택지를 제시해봐' },
    { id: 'q', turnId: 'turn', kind: 'assistant', createdAt: 2, text: `어떤 과일을 고르시겠어요?\n\n${marker} 사과\n${marker} 딸기` },
    { id: 'notice', turnId: 'turn', kind: 'assistant', createdAt: 3, text: '질문 카드에서 사과 또는 딸기를 선택해주세요.' },
  ], 'thread');
  expect(result).toMatchObject({ turnId: 'turn', sourceItemId: 'q', legacyQuestionId: 'question:thread:q',
    id: 'question:["thread","turn","q"]', questions: [{ options: [{ label: '사과' }, { label: '딸기' }] }] });
});

test('does not revive a question from an older turn, including when the latest turn only contains activity', () => {
  const old = { id: 'q', turnId: 'old', kind: 'assistant' as const, createdAt: 1, text };
  expect(fallbackQuestionRequest([old, { ...old, id: 'new', turnId: 'new', text: '작업 완료했습니다.' }], 'thread')).toBeNull();
  expect(fallbackQuestionRequest([old, { id: 'tool', turnId: 'new', kind: 'activity', activity: 'tool',
    label: 'Tool', detail: '', status: 'completed' }], 'thread')).toBeNull();
});

test('uses the latest question within a turn, keeps turn identities distinct, and stops at a user answer', () => {
  const old = { id: 'q', turnId: 'turn', kind: 'assistant' as const, createdAt: 1, text };
  const latest = { ...old, id: 'new-question' };
  expect(fallbackQuestionRequest([old, latest], 'thread')?.sourceItemId).toBe('new-question');
  expect(fallbackQuestionRequest([old], 'thread')?.id).not.toBe(fallbackQuestionRequest([{ ...old, turnId: 'another' }], 'thread')?.id);
  expect(fallbackQuestionRequest([old, { id: 'answer', kind: 'user', createdAt: 2, text: '사과' },
    { ...old, id: 'thanks', text: '알겠습니다.' }], 'thread')).toBeNull();
});

test('legacy messages without turn metadata still allow a trailing notice within the user response boundary', () => {
  expect(fallbackQuestionRequest([{ id: 'q', kind: 'assistant', createdAt: 1, text },
    { id: 'notice', kind: 'assistant', createdAt: 2, text: '선택해주세요.' }], 'thread')?.id).toBe('question:thread:q');
});

test.each([
  '설치는 어떻게 하나요?\n\n1. 내려받기\n2. 실행',
  '설치 순서\n\n1. 사과\n2. 딸기',
  'Which option?\n\n1. Only one',
  'Which option?\n\n1. Apple\n2. Apple',
  'Which option?\n\n1. Apple\n   - Nested\n2. Strawberry',
  'Which option?\n\n- Apple\n  - Nested\n- Strawberry',
  'Which option?\n\n- [ ] Apple\n- [ ] Strawberry',
  'Which option?\n\n- Apple\n* Strawberry',
  '작업 목록\n\n- 사과\n- 딸기',
  'Which option?\n\n1. [Apple](https://example.com)\n2. Strawberry',
  'Which option?\n\n1. [ ] Apple\n2. [ ] Strawberry',
  '> Which option?\n>\n> 1. Apple\n> 2. Strawberry',
  'Which option?\n\n1. Apple\n2. Strawberry\n\nThis was an example.',
  `\`\`\`text\n${text}`,
  `~~~text\n${text}\n~~~`,
])('does not turn ordinary or literal Markdown into a question: %s', value => {
  expect(plainTextQuestion(value)).toBeNull();
});

test('sends only on explicit response, targets its thread, and prevents duplicate submissions', async () => {
  const completion = createDeferred<ChatSendResult>();
  const sent: { text: string; threadId: string }[] = [];
  const store = createFallbackQuestionStore(async (text, threadId) => { sent.push({ text, threadId }); return completion.promise; });
  store.sync('thread', request, false);
  expect(sent).toEqual([]);
  const first = store.respond(request.id, answer);
  expect(await store.respond(request.id, answer)).toBe(false);
  store.sync('thread', null, true);
  expect(store.getSnapshot()).toMatchObject({ request, pending: true });
  expect(sent).toEqual([{ text: '사과\n\n추가 설명', threadId: 'thread' }]);
  completion.resolve({ status: 'accepted' });
  expect(await first).toBe(true);
  store.sync('thread', request, false);
  expect(store.getSnapshot().request).toBeNull();
});

test.each(['decline', 'cancel'] as const)('%s dismisses the plain-text card without sending a message', async action => {
  let sends = 0;
  const store = createFallbackQuestionStore(async () => { sends++; return { status: 'accepted' }; });
  store.sync('thread', request, false);
  expect(await store.respond(request.id, { action })).toBe(true);
  store.sync('thread', request, false);
  expect(store.getSnapshot().request).toBeNull();
  expect(sends).toBe(0);
});

test('confirmed failure retains the same card for retry, while unknown delivery cannot be repeated', async () => {
  let result: ChatSendResult = { status: 'failed', message: 'Rejected' };
  let sends = 0;
  const store = createFallbackQuestionStore(async () => { sends++; return result; });
  store.sync('thread', request, false);
  expect(await store.respond(request.id, answer)).toBe(false);
  store.sync('thread', null, false);
  expect(store.getSnapshot()).toMatchObject({ request, pending: false, error: 'Rejected' });
  result = { status: 'unknown' };
  expect(await store.respond(request.id, answer)).toBe(false);
  expect(await store.respond(request.id, answer)).toBe(false);
  expect(sends).toBe(2);
  expect(store.getSnapshot().uncertain).toBe(true);
  expect(await store.respond(request.id, { action: 'cancel' })).toBe(true);
});

test('a late result cannot remove another conversation card and stale or blocked responses do not send', async () => {
  const completion = createDeferred<ChatSendResult>();
  let sends = 0;
  const store = createFallbackQuestionStore(async () => { sends++; return completion.promise; });
  store.sync('thread', request, true);
  expect(await store.respond(request.id, answer)).toBe(false);
  store.sync('thread', request, false);
  const pending = store.respond(request.id, answer);
  const other = { ...request, id: 'other', threadId: 'other' };
  store.sync('other', other, false);
  expect(await store.respond(request.id, answer)).toBe(false);
  completion.resolve({ status: 'accepted' });
  expect(await pending).toBe(false);
  expect(store.getSnapshot().request).toEqual(other);
  store.setActive(false);
  expect(await store.respond(other.id, answer)).toBe(false);
  expect(sends).toBe(1);
});

interface Element { type: unknown; props: Record<string, unknown> }
function cardHarness() {
  let index = 0;
  const slots: unknown[] = [];
  const calls: { id: string; response: ChatUserInputResponse }[] = [];
  const input = { requests: [] as ChatUserInputRequest[], loadingId: null, error: null, respond: async () => true };
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
        return [slots[slot], (value: unknown) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; },
      useRef(current: unknown) { return slots[index++] ??= { current }; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { ExternalLink: 'icon', MessageCircleQuestion: 'icon', X: 'icon' },
    '../../shared/ui': { LiquidGlassPanel: 'panel', NeumorphicButton: 'button' },
    '../../shared/useHelpLanguage': { useHelpLanguage: () => ['ko'] },
    './ChatUserInputFields': { ChatMcpFields: 'fields', ChatQuestionFields: 'questions' },
    './chatUserInputForm': { initialInputDraft, inputResponse, userInputLink },
    './useChatUserInputs': { useChatUserInputs: () => input },
    './ChatUserInputPrompt.module.css': { default: {} }, './ChatErrorNotice': { ChatErrorNotice: 'error' },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/ChatUserInputPrompt.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX } });
  const exports: Record<string, (props: Record<string, unknown>) => Element | null> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } });
  const props = { request, pending: false, error: null, respond: async (id: string, response: ChatUserInputResponse) => { calls.push({ id, response }); return true; } };
  const render = () => { index = 0; return exports.ChatUserInputPrompt!(props); };
  function elements(node: unknown): Element[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const element = node as Element;
    return [element, ...elements(element.props.children)];
  }
  const find = (predicate: (node: Element) => boolean) => {
    const found = elements(render()).find(predicate); assert.ok(found); return found;
  };
  const invoke = (node: Element, name: string, ...args: unknown[]) => {
    const handler = node.props[name]; assert.ok(typeof handler === 'function'); handler(...args);
  };
  return { props, calls, input, find, invoke, renderRequests(fallbackId = request.id) {
    index = 0;
    return exports.ChatUserInputRequests!({ contextId: 'context', activeThreadId: 'thread', fallbackId, fallback: jsx('fallback', {}) });
  } };
}

test('card keeps selection and custom details local until Send, then transmits both explicitly', async () => {
  const card = cardHarness();
  expect(card.find(node => node.props.type === 'submit').props.disabled).toBe(true);
  card.invoke(card.find(node => node.type === 'questions'), 'onChange', 'answer', '사과');
  card.invoke(card.find(node => node.type === 'questions'), 'onNotesChange', 'answer', '추가 설명');
  expect(card.calls).toEqual([]);
  expect(card.find(node => node.props.type === 'submit').props.disabled).toBe(false);
  card.invoke(card.find(node => node.type === 'form'), 'onSubmit', { preventDefault() {} });
  expect(card.calls).toEqual([{ id: request.id, response: answer }]);
  await Promise.resolve();
});

test('card sends a custom answer without a selected option and close or skip use their own actions', async () => {
  const card = cardHarness();
  card.invoke(card.find(node => node.type === 'questions'), 'onNotesChange', 'answer', '바나나');
  card.invoke(card.find(node => node.type === 'form'), 'onSubmit', { preventDefault() {} });
  expect(card.calls[0]?.response.answers?.answer).toEqual(['바나나']);
  await Promise.resolve();
  for (const action of ['cancel', 'decline'] as const) {
    const next = cardHarness();
    next.invoke(next.find(node => node.props['aria-label'] === '질문 닫기' && action === 'cancel'
      || node.props.children === '건너뛰기' && action === 'decline'), 'onClick');
    expect(next.calls[0]?.response).toEqual({ action });
    await Promise.resolve();
  }
});

test('a real server question takes precedence and suppresses a duplicate fallback after resolution', () => {
  const card = cardHarness();
  card.input.requests = [request];
  expect(card.renderRequests()?.type).not.toBe('fallback');
  card.input.requests = [];
  expect(card.renderRequests()).toBeNull();
  expect(card.renderRequests('new-question')?.type).toBe('fallback');
});

test('the same question cannot send twice after switching away and back during delivery', async () => {
  const completion = createDeferred<ChatSendResult>();
  let sends = 0;
  const store = createFallbackQuestionStore(async () => { sends++; return completion.promise; });
  store.sync('thread', request, false);
  const pending = store.respond(request.id, answer);
  store.sync('other', null, false);
  store.sync('thread', request, false);
  expect(await store.respond(request.id, answer)).toBe(false);
  completion.resolve({ status: 'accepted' });
  await pending;
  store.sync('thread', request, false);
  expect(store.getSnapshot().request).toBeNull();
  expect(sends).toBe(1);
});

test('card keeps typed details after a failed response and blocks a double Send while pending', async () => {
  const card = cardHarness();
  const completion = createDeferred<boolean>();
  card.props.respond = async (id, response) => { card.calls.push({ id, response }); return completion.promise; };
  card.invoke(card.find(node => node.type === 'questions'), 'onNotesChange', 'answer', '작성한 답변');
  card.invoke(card.find(node => node.type === 'form'), 'onSubmit', { preventDefault() {} });
  card.invoke(card.find(node => node.type === 'form'), 'onSubmit', { preventDefault() {} });
  expect(card.calls).toHaveLength(1);
  expect(card.find(node => node.props.type === 'submit').props.disabled).toBe(true);
  completion.resolve(false);
  for (let index = 0; index < 5; index++) await Promise.resolve();
  expect(card.find(node => node.type === 'questions').props.notes).toEqual({ answer: '작성한 답변' });
  expect(card.find(node => node.props.type === 'submit').props.disabled).toBe(false);
});
