import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Children, act, isValidElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { ShieldCheck } from 'lucide-react';
import * as controls from '../frontend/src/shared/ui';
import { ChatErrorNotice } from '../frontend/src/features/chat/ChatErrorNotice';

function approvalHarness() {
  const calls: string[] = [];
  const controller = {
    attachmentTransfer: {}, state: { items: [], activeSessionId: 'thread' }, messageQueue: { entries: [] },
    pendingApproval: { id: 'approval', title: 'Run command', detail: 'Review this command\nand its directory.', canAllowForSession: true },
    approvalLoadingId: null as string | null, approvalError: null as string | null,
    answerApproval: (value: string) => { calls.push(value); },
  };
  const modules: Record<string, unknown> = {
    react: { useId: () => 'queue', useMemo: (fn: () => unknown) => fn(), useState: (value: unknown) => [value, () => {}] },
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': { ShieldCheck }, '../../shared/ui': controls,
    './ChatComposer.module.css': { default: {} },
    './useChatInputHistory': { useChatInputHistory: () => ({ state: {}, open: false }) },
    './chatQuestionChoices': { composerQuestionRequest: () => null },
  };
  for (const name of ['ChatErrorNotice', 'ChatCommandMenu', 'ChatConfigurationMenu', 'ChatInputHistoryPanel',
    'ChatComposerSurface', 'ChatComposerAttachments', 'ChatComposerToolbar', 'ChatPlanToggle', 'ChatUserInputPrompt', 'GithubLinkChips', 'ChatMessageQueue', 'ChatFallbackQuestion']) {
    modules[`./${name}`] = {};
  }
  const source = readFileSync(new URL('../frontend/src/features/chat/ChatComposer.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Missing test dependency: ${name}`);
    return modules[name];
  } });
  const render = () => {
    // Supply only the controller fields consumed by this isolated composer boundary.
    const component = exports.ChatComposer as (props: unknown) => { props: { children: ReactNode } };
    const footer = component({ controller, chatController: { sessionRevision: 0 } });
    return Children.toArray(footer.props.children).find(child => isValidElement(child) && child.type === controls.ContentCard);
  };
  return { controller, calls, render };
}

async function withDom(run: (container: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement('div') as unknown as HTMLElement;
  const root = createRoot(container);
  try { await run(container, root); } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('approval card retains all decisions, pending locks, session eligibility, and errors', async () => {
  const app = approvalHarness();
  await withDom(async (container, root) => {
    const render = async () => { await act(async () => root.render(app.render())); };
    await render();
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Run command');
    expect(container.textContent).toContain(app.controller.pendingApproval.detail);
    for (const button of container.querySelectorAll('button')) await act(async () => button.click());
    expect(app.calls).toEqual(['decline', 'accept', 'acceptForSession']);
    app.controller.approvalLoadingId = 'approval';
    await render();
    for (const button of container.querySelectorAll('button')) {
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
    }
    expect(app.calls).toHaveLength(3);
    app.controller.approvalLoadingId = null;
    app.controller.pendingApproval.canAllowForSession = false;
    app.controller.approvalError = 'Could not submit approval';
    await render();
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(app.controller.approvalError);
  });
});

test('error card retains the complete message, retry, and optional dismissal', async () => {
  await withDom(async (container, root) => {
    const calls: string[] = [];
    const message = 'Could not complete request.\nDetails: <script>literal</script>';
    await act(async () => root.render(<ChatErrorNotice onDismiss={() => calls.push('dismiss')}
      action={<controls.NeumorphicButton variant="standard" onClick={() => calls.push('retry')}>Retry</controls.NeumorphicButton>}
    >{message}</ChatErrorNotice>));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(container.querySelector('script')).toBeNull();
    for (const button of container.querySelectorAll('button')) await act(async () => button.click());
    expect(calls).toEqual(['retry', 'dismiss']);
    await act(async () => root.render(<ChatErrorNotice>{message}</ChatErrorNotice>));
    expect(container.querySelector('button')).toBeNull();
  });
});
