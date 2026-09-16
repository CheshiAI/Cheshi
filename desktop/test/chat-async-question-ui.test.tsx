import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { ComponentProps } from 'react';
import type { ChatFallbackQuestion } from '../frontend/src/features/chat/ChatFallbackQuestion';
import type { ChatUserInputResponse } from '../shared/chat-user-input';
import { INITIAL_CHAT_STATE, isViewedSessionResponding } from '../frontend/src/features/chat/model';
import { createFallbackQuestionStore } from '../frontend/src/features/chat/chatFallbackQuestionStore';
import { fallbackQuestionRequest } from '../frontend/src/features/chat/chatQuestionChoices';

type Props = ComponentProps<typeof ChatFallbackQuestion>;
type Element = { type: unknown; props: Record<string, unknown> };
const candidate = fallbackQuestionRequest([{ id: 'q', turnId: 'turn', kind: 'assistant', text: '본문과 무관한 데이터', createdAt: 1,
  asyncQuestions: [{ title: '만들까요, 아니면 함께 만들까요?', options: ['스킬', '스킬과 에이전트'] }] }], 'thread')!;
const answer: ChatUserInputResponse = { action: 'accept', answers: { 'answer-1': ['스킬과 에이전트'] } };

function harness() {
  let cursor = 0;
  const slots: unknown[] = [];
  let effects: (() => void)[] = [];
  const sends: { text: string; delivery: unknown }[] = [];
  const state = { ...INITIAL_CHAT_STATE, activeSessionId: 'thread', responseThreadIds: ['thread'] };
  const chatController = {
    state, isOperationPending: () => false,
    sendMessage: async (text: string, _skill: unknown, _attachments: unknown, delivery: unknown) => {
      sends.push({ text, delivery }); return { status: 'accepted' as const };
    },
  };
  const controller = {
    state, streaming: true, loading: false, queueBlocked: false, configurationControlsDisabled: true,
    configurationMenuOpen: false, configurationLoading: false, attachmentPickerOpen: false, attachmentTransfer: { loading: false },
  };
  // Inject only the controller boundary used by this component; run its real store and effects.
  const props: Props = { candidate, controller: controller as unknown as Props['controller'],
    chatController: chatController as unknown as Props['chatController'], active: true };
  const modules: Record<string, unknown> = {
    react: {
      useRef(current: unknown) { const index = cursor++; return slots[index] ??= { current }; },
      useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot(); },
      useLayoutEffect(effect: () => void, dependencies?: unknown[]) {
        const index = cursor++;
        const previous = slots[index] as unknown[] | undefined;
        if (!dependencies || !previous || dependencies.some((value, i) => value !== previous[i])) effects.push(effect);
        slots[index] = dependencies;
      },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }) },
    './model': { isViewedSessionResponding },
    './chatFallbackQuestionStore': { createFallbackQuestionStore },
    './ChatUserInputPrompt': { ChatUserInputPrompt: 'question-card' },
    './ChatErrorNotice': { ChatErrorNotice: 'error' },
    '../../shared/ui': { NeumorphicButton: 'button' },
    '../../cheshiDesktop': { cheshiDesktop: { chatQuestionDismissals: {
      list: async () => [], save: async (_threadId: string, record: unknown) => record,
    } } },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/ChatFallbackQuestion.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name];
  } });
  const component = exports.ChatFallbackQuestion;
  assert.ok(typeof component === 'function');
  return {
    props, state, controller, sends,
    render() {
      cursor = 0; effects = [];
      const result = component(props) as Element | null;
      effects.forEach(effect => effect());
      return result;
    },
    async settle() {
      this.render();
      for (let index = 0; index < 5; index++) await Promise.resolve();
      this.render(); return this.render();
    },
  };
}

async function respond(element: Element | null, response = answer) {
  assert.ok(element && element.type === 'question-card');
  const handler = element.props.respond;
  assert.ok(typeof handler === 'function');
  return handler(candidate.id, response);
}

test('uses the existing selectable question component while streaming and steers an explicit answer', async () => {
  const h = harness();
  const card = await h.settle();
  expect(card?.type).toBe('question-card');
  expect(card?.props.request).toEqual(candidate);
  expect(card?.props.answerDisabled).toBe(false);
  expect(h.sends).toEqual([]);
  expect(await respond(card)).toBe(true);
  expect(h.sends).toEqual([{ text: '만들까요, 아니면 함께 만들까요?\n스킬과 에이전트', delivery: { threadId: 'thread', mode: 'steer' } }]);
  expect(h.render()).toBeNull();
});

test('an unanswered async card remains available after completion and sends the next turn', async () => {
  const h = harness(); await h.settle();
  h.state.responseThreadIds = [];
  h.controller.streaming = false;
  h.controller.configurationControlsDisabled = false;
  const card = h.render();
  expect(card?.props.answerDisabled).toBe(false);
  expect(await respond(card)).toBe(true);
  expect(h.sends[0]?.delivery).toEqual({ threadId: 'thread', mode: 'next-turn' });
});

test('async answers remain blocked during other operations and become stale on conversation switches', async () => {
  const h = harness();
  h.controller.queueBlocked = true;
  let card = await h.settle();
  expect(card?.props.answerDisabled).toBe(true);
  expect(await respond(card)).toBe(false);
  h.controller.queueBlocked = false;
  card = h.render();
  expect(card?.props.answerDisabled).toBe(false);
  h.state.activeSessionId = 'other'; h.props.candidate = null; h.render();
  expect(await respond(card)).toBe(false);
  expect(h.sends).toEqual([]);
});

test('ordinary text fallback keeps its existing end-of-turn behavior', async () => {
  const h = harness();
  h.props.candidate = fallbackQuestionRequest([{ id: 'q', kind: 'assistant', text: 'Which one?\n- A\n- B', createdAt: 1 }], 'thread');
  expect(await h.settle()).toBeNull();
  h.state.responseThreadIds = [];
  h.controller.streaming = false;
  h.controller.configurationControlsDisabled = false;
  expect((await h.settle())?.type).toBe('question-card');
  expect(h.sends).toEqual([]);
});
