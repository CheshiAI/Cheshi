import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { ChatAsyncQuestionContext, ChatAsyncQuestions, asyncQuestionAnswerText } from '../frontend/src/features/chat/ChatAsyncQuestions';
import type { ChatSendResult } from '../frontend/src/features/chat/chatDraftRecovery';
import type { InputDraft } from '../frontend/src/features/chat/chatUserInputForm';
import type { ChatAsyncQuestion } from '../shared/chat-async-question';
import { completedAsyncQuestionAnswers } from '../frontend/src/features/chat/chatAsyncQuestionAnswers';

const questions: ChatAsyncQuestion[] = [
  { title: 'Where should copying apply?', options: ['Entire app', 'Chat only'] },
  { title: 'Anything else?', options: null },
];
type Sender = (text: string) => Promise<ChatSendResult>;
interface TestElement {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function descendants(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('props' in value) || !('type' in value)) return [];
  const element = value as TestElement;
  return [element, ...descendants(element.props.children)];
}

function harness(send: Sender, disabled = false, connected = true) {
  let context: { send: Sender; disabled: boolean; answers?: ReadonlyMap<string, InputDraft> } | null = connected ? { send, disabled } : null;
  const slots: Array<{ value: unknown }> = [];
  let cursor = 0;
  const fieldsMarker = Symbol('Question fields');
  const element = (type: unknown, props: TestElement['props']): TestElement => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      createContext: () => ({}),
      useContext: () => context,
      useState(initial: unknown) {
        const index = cursor++;
        const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
        return [slot.value, (next: unknown) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
        }];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        return (slots[index] ??= { value: { current: initial } }).value;
      },
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '../../shared/ui': { LiquidGlassPanel: 'panel', NeumorphicButton: 'button' },
    './ChatUserInputFields': { ChatQuestionFields: fieldsMarker },
    './ChatUserInputPrompt.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/ChatAsyncQuestions.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports, Error,
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  const component = exports.ChatAsyncQuestions;
  assert.ok(typeof component === 'function');
  return {
    setDisabled(value: boolean) { context = { send, disabled: value }; },
    setAnswers(answers: ReadonlyMap<string, InputDraft>) { context = { send, disabled, answers }; },
    render(input = questions) {
      cursor = 0;
      const tree = descendants(component({ questions: input, itemId: 'question' }));
      const find = (type: unknown): TestElement => {
        const result = tree.find((entry) => entry.type === type);
        assert.ok(result, `Missing element ${String(type)}`);
        return result;
      };
      const fields = find(fieldsMarker).props;
      const onChange = fields.onChange as (name: string, value: string | string[]) => void;
      const submit = find('form').props.onSubmit as (event: { preventDefault: () => void }) => void;
      return {
        draft: fields.draft as InputDraft,
        change: onChange,
        submit: () => submit({ preventDefault() {} }),
        disabled: find('fieldset').props.disabled,
        button: find('button').props.children,
        alert: tree.find((entry) => entry.props.role === 'alert')?.props.children,
        status: tree.find((entry) => entry.props.role === 'status')?.props.children,
      };
    },
  };
}

test('renders choices with a collapsed custom answer and an always available required free text answer', () => {
  let sent = 0;
  const html = renderToStaticMarkup(<ChatAsyncQuestionContext.Provider value={{ disabled: false, send: async () => {
    sent++;
    return { status: 'accepted' };
  } }}><ChatAsyncQuestions questions={questions} /></ChatAsyncQuestionContext.Provider>);
  expect(html.match(/type="radio"/g)).toHaveLength(2);
  expect(html.match(/checked=""/g)).toHaveLength(1);
  expect(html).toContain('Entire app');
  expect(html).toContain('Chat only');
  expect(html).toContain('Your own answer');
  expect(html.match(/<details\b/g)).toHaveLength(1);
  expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  expect(html).toContain('Your answer');
  expect(html).toContain('required=""');
  expect(html).toContain('type="submit"');
  expect(html).toContain('Submit answers');
  expect(sent).toBe(0);
});

test('returning from an agent or reopening history restores answers and prevents resubmission', async () => {
  const answers = completedAsyncQuestionAnswers([
    { id: 'question', kind: 'assistant', text: '', questions, createdAt: 1 },
    { id: 'answer', kind: 'user', text: 'Where should copying apply?\nChat only\n\nAnything else?\nSaved note', createdAt: 2 },
  ]);
  let sends = 0;
  for (let visit = 0; visit < 2; visit++) {
    const app = harness(async () => { sends++; return { status: 'accepted' }; });
    app.setAnswers(answers);
    const restored = app.render();
    expect(restored.draft).toEqual({ '0': 'Chat only', '1': 'Saved note' });
    expect(restored.disabled).toBe(true);
    expect(restored.button).toBe('Answer sent');
    restored.submit();
    await settle();
  }
  expect(sends).toBe(0);
});

test('an answer arriving in history completes an already mounted question card', async () => {
  let sends = 0;
  const app = harness(async () => { sends++; return { status: 'accepted' }; });
  expect(app.render().disabled).toBe(false);
  app.setAnswers(new Map([['question', { '0': 'Chat only', '1': 'Answered elsewhere' }]]));
  const completed = app.render();
  expect(completed.draft['1']).toBe('Answered elsewhere');
  expect(completed.disabled).toBe(true);
  completed.submit();
  await settle();
  expect(sends).toBe(0);
});

test('read only questions remain visible with their controls disabled', () => {
  const html = renderToStaticMarkup(<ChatAsyncQuestions questions={questions} />);
  expect(html).toContain('Where should copying apply?');
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  expect(html).toMatch(/<button[^>]*disabled=""/);
});

test('serializes question titles and trimmed answers while preserving answer line breaks', () => {
  expect(asyncQuestionAnswerText(questions, { '0': 'Chat only', '1': '  Keep\nline breaks  ' }))
    .toBe('Where should copying apply?\nChat only\n\nAnything else?\nKeep\nline breaks');
  expect(() => asyncQuestionAnswerText(questions, { '0': 'Entire app' })).toThrow('Answer Anything else?');
  for (const answer of ['', '   ', ['Entire app']]) {
    expect(() => asyncQuestionAnswerText(questions, { '0': 'Entire app', '1': answer }))
      .toThrow('Answer Anything else?');
  }
});

test('waits for explicit submit and sends edited choices and custom text', async () => {
  const sent: string[] = [];
  const app = harness(async (text) => { sent.push(text); return { status: 'accepted' }; });
  const initial = app.render();
  expect(initial.draft).toEqual({ '0': 'Entire app', '1': '' });
  initial.change('0', 'Chat only');
  app.render().change('1', 'Keep formatting');
  expect(sent).toEqual([]);
  app.render().submit();
  await settle();
  expect(sent).toEqual(['Where should copying apply?\nChat only\n\nAnything else?\nKeep formatting']);
  const done = app.render();
  expect(done.button).toBe('Answer sent');
  expect(done.status).toBe('Your answer was sent.');
  expect(done.disabled).toBe(true);
  done.submit();
  expect(sent).toHaveLength(1);
});

test('blocks duplicate submissions before rerender and while sending', async () => {
  const response = createDeferred<ChatSendResult>();
  let calls = 0;
  const app = harness(() => { calls++; return response.promise; });
  app.render().change('1', 'No');
  const ready = app.render();
  ready.submit();
  ready.submit();
  const pending = app.render();
  expect(pending.disabled).toBe(true);
  expect(pending.button).toBe('Sending…');
  pending.submit();
  expect(calls).toBe(1);
  response.resolve({ status: 'accepted' });
  await settle();
  expect(app.render().button).toBe('Answer sent');
});

for (const status of ['failed', 'unknown', 'blocked'] as const) {
  test(`retains choices and allows retry after a ${status} send result`, async () => {
    let calls = 0;
    const app = harness(async () => ++calls === 1 ? { status, message: 'Please retry' } : { status: 'accepted' });
    app.render().change('0', 'My custom scope');
    app.render().change('1', 'No');
    app.render().submit();
    await settle();
    const failed = app.render();
    expect(failed.alert).toBe('Please retry');
    expect(failed.disabled).toBe(false);
    expect(failed.draft).toEqual({ '0': 'My custom scope', '1': 'No' });
    failed.submit();
    await settle();
    expect(calls).toBe(2);
    expect(app.render().alert).toBeUndefined();
    expect(app.render().button).toBe('Answer sent');
  });
}

test('shows rejected sends and validation errors without losing existing answers', async () => {
  const pending = createDeferred<ChatSendResult>();
  let calls = 0;
  const app = harness(() => { calls++; return pending.promise; });
  app.render().submit();
  await settle();
  expect(calls).toBe(0);
  expect(app.render().alert).toBe('Answer Anything else?');
  app.render().change('1', 'No changes');
  app.render().submit();
  pending.reject(new Error('Connection interrupted'));
  await settle();
  const failed = app.render();
  expect(failed.alert).toBe('Connection interrupted');
  expect(failed.draft['1']).toBe('No changes');
  expect(failed.disabled).toBe(false);
});

test('blocks submission when disconnected or disabled by the chat', async () => {
  for (const connected of [false, true]) {
    let calls = 0;
    const app = harness(async () => { calls++; return { status: 'accepted' }; }, true, connected);
    app.render().change('1', 'No');
    const blocked = app.render();
    expect(blocked.disabled).toBe(true);
    blocked.submit();
    await settle();
    expect(calls).toBe(0);
    app.setDisabled(false);
    app.render().submit();
    await settle();
    expect(calls).toBe(1);
  }
});
