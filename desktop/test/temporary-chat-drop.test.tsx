import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import { TemporaryChatSession, initialTemporaryChatState, type TemporaryChatApi } from '../frontend/src/features/chat/temporaryChatSession';
import { INITIAL_CHAT_STATE } from '../frontend/src/features/chat/model';
import { temporaryChatItems } from '../frontend/src/features/chat/temporaryChatTimeline';
import * as transfer from '../frontend/src/features/chat/attachmentTransferModel';
import type { TemporaryChatDraft, TemporaryChatRequest } from '../shared/temporary-chat';
import { WORKSPACE_FILE_TRANSFER_TYPE } from '../frontend/src/shared/workspaceFileTransfer';

interface Element { type: unknown; props: Record<string, unknown> }
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

function harness(draft: TemporaryChatDraft | null = null, overrides: Partial<TemporaryChatApi> = {}) {
  const imports: unknown[] = [];
  const sends: TemporaryChatRequest[] = [];
  const openedListeners = new Set<() => void>();
  const accepted: (string | undefined)[] = [];
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: (() => (() => void) | undefined)[] = [];
  const cleanups: (() => void)[] = [];
  let cursor = 0;
  let refCursor = 0;
  let mounted = false;
  const api: TemporaryChatApi & {
    initialDraft(): Promise<TemporaryChatDraft | null>; acceptDraft(error?: string): Promise<void>;
    onOpened(listener: () => void): () => void;
  } = {
    initialDraft: async () => draft,
    acceptDraft: async error => { accepted.push(error); },
    onOpened: listener => { openedListeners.add(listener); return () => { openedListeners.delete(listener); }; },
    models: async () => [{ id: 'model', model: 'model', displayName: 'Model', description: '', isDefault: true,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: [], serviceTiers: [], defaultServiceTier: null }],
    selectAttachments: async () => [],
    importAttachments: async (id, files) => {
      imports.push({ id, files });
      return files.map(file => {
        assert.ok(typeof file === 'string', 'Explorer drops must supply file paths.');
        return { kind: 'file' as const, name: file.split('/').at(-1)!, path: file };
      });
    },
    send: async (_id, request) => { sends.push(request); return { text: 'Reply', model: 'model' }; },
    close: async () => {},
    ...overrides,
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (index >= states.length) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], (value: unknown) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        }];
      },
      useRef(initial: unknown) { const index = refCursor++; return refs[index] ??= { current: initial }; },
      useEffect(effect: () => (() => void) | undefined) { if (!mounted) effects.push(effect); },
      useLayoutEffect: () => {},
      useMemo: (compute: () => unknown) => compute(),
      useCallback: (callback: unknown) => callback,
      useId: () => 'temporary-id',
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: (node: unknown) => node },
    'lucide-react': Object.fromEntries(['ArrowUp', 'Bot', 'ChevronDown', 'MessageCircleDashed', 'Paperclip', 'X'].map(name => [name, name])),
    '../../cheshiDesktop': { cheshiDesktop: { temporaryChat: api } },
    '../../shared/ui': Object.fromEntries(['LiquidGlassPanel', 'LoadingIndicator', 'LoadingState', 'NeumorphicButton', 'NeumorphicTextField', 'SidebarPanelHeader'].map(name => [name, name])),
    '../../shared/ui/DismissibleToast.module.css': { default: {} },
    './MessageContent': { MessageContent: 'MessageContent' },
    './ChatMessageLabel': { ChatMessageLabel: 'ChatMessageLabel' },
    './chatViewModel': { formatReasoningEffort: (effort: string) => effort },
    './temporaryChatSession': { TemporaryChatSession, initialTemporaryChatState },
    './TemporaryChatPanel.module.css': { default: {} },
    './TemporaryChatConfigurationMenu': { TemporaryChatConfigurationMenu: 'TemporaryChatConfigurationMenu' },
    './attachmentTransferModel': transfer,
    '../../shared/useAutoHideScrollbars': { useAutoHideScrollbars: () => () => {} },
    './ChatTimeline': { ChatTimeline: 'ChatTimeline' },
    './ChatViewSurface': { ChatViewSurface: 'ChatViewSurface' },
    './ChatComposerSurface': { ChatComposerSurface: 'ChatComposerSurface', ChatComposerInput: 'ChatComposerInput', ChatComposerDisclaimer: 'ChatComposerDisclaimer' },
    './ChatComposerAttachments': { ChatComposerAttachments: 'ChatComposerAttachments' },
    './ChatSubmitButton': { ChatSubmitButton: 'ChatSubmitButton' },
    './ChatErrorNotice': { ChatErrorNotice: 'ChatErrorNotice' },
    './model': { INITIAL_CHAT_STATE },
    './chatComposerOverlay': { syncChatComposerOverlayHeight: () => false },
    './temporaryChatTimeline': { temporaryChatItems },
    './ChatComposer.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/TemporaryChatPanel.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports, document: { activeElement: null, body: {} }, crypto: { randomUUID: () => 'drop-session' }, console, Error,
    HTMLElement: class {}, window: { dispatchEvent() {} }, Event: class {},
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; },
  });
  const component = exports.TemporaryChatPanel;
  assert.equal(typeof component, 'function');
  return {
    imports, sends, accepted,
    get state() { return states[0] as import('../frontend/src/features/chat/temporaryChatSession').TemporaryChatState; },
    opened() { for (const listener of openedListeners) listener(); },
    render() {
      cursor = 0; refCursor = 0;
      const tree = (component as (props: { onClose(): void }) => unknown)({ onClose() {} });
      if (!mounted) for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
      mounted = true;
      const form = elements(tree).find(element => element.type === 'ChatViewSurface');
      assert.ok(form);
      return form;
    },
    close() { for (const cleanup of cleanups) cleanup(); },
  };
}

function dragEvent(types: string[], paths: string[]) {
  let prevented = false;
  let stopped = false;
  return {
    dataTransfer: { types, dropEffect: 'none', files: [], items: [], getData: () => JSON.stringify(paths) },
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
    get consumed() { return prevented && stopped; },
  };
}
function dispatch(form: Element, name: string, event: ReturnType<typeof dragEvent>) {
  const handler = form.props[name];
  assert.equal(typeof handler, 'function');
  (handler as (event: ReturnType<typeof dragEvent>) => void)(event);
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test('Explorer drops reach the temporary session and suppress default file navigation', async () => {
  const app = harness();
  try {
    app.render();
    await settle();
    const form = app.render();
    const event = dragEvent([WORKSPACE_FILE_TRANSFER_TYPE], ['/workspace/작업 notes.txt']);
    dispatch(form, 'onDragOver', event);
    expect(event.dataTransfer.dropEffect).toBe('copy');
    dispatch(form, 'onDrop', event);
    await settle();
    expect(event.consumed).toBe(true);
    expect(app.imports).toEqual([{ id: 'drop-session', files: ['/workspace/작업 notes.txt'] }]);
  } finally { app.close(); }
});

test('loading blocks file drops while ordinary text drags remain untouched', async () => {
  const app = harness();
  try {
    const form = app.render();
    const event = dragEvent([WORKSPACE_FILE_TRANSFER_TYPE], ['/workspace/notes.txt']);
    dispatch(form, 'onDragOver', event);
    dispatch(form, 'onDrop', event);
    expect(event.dataTransfer.dropEffect).toBe('none');
    expect(event.consumed).toBe(true);
    expect(app.imports).toEqual([]);
    const text = dragEvent(['text/plain'], []);
    dispatch(form, 'onDragOver', text);
    dispatch(form, 'onDrop', text);
    expect(text.consumed).toBe(false);
    await settle();
  } finally { app.close(); }
});


test('queued questions automatically send once only after their new window opens', async () => {
  const draft: TemporaryChatDraft = { text: 'Run immediately', attachments: [{ kind: 'file', name: 'a.txt', path: '/workspace/a.txt' }] };
  const app = harness(draft);
  try {
    app.render(); await settle();
    expect(app.accepted).toEqual([undefined]);
    expect(app.sends).toEqual([]);
    app.opened(); await settle(); app.render();
    expect(app.sends).toHaveLength(1);
    expect(app.sends[0]).toMatchObject(draft);
    expect(app.state.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    app.opened(); app.render(); await settle();
    expect(app.sends).toHaveLength(1);
  } finally { app.close(); }
});

test('ordinary empty windows do not auto-send and closed windows cannot send late', async () => {
  for (const draft of [null, { text: 'Closed before opening', attachments: [] }]) {
    const app = harness(draft);
    app.render(); await settle();
    if (draft) app.close();
    app.opened(); await settle();
    expect(app.sends).toHaveLength(0);
    if (!draft) app.close();
  }
});

test('automatic send failure preserves the question and attachments in its temporary window', async () => {
  let attempts = 0;
  const draft: TemporaryChatDraft = { text: 'Keep on failure', attachments: [{ kind: 'file', name: 'a.txt', path: '/workspace/a.txt' }] };
  const app = harness(draft, { send: async () => { attempts++; throw new Error('Provider failed'); } });
  try {
    app.render(); await settle(); app.opened(); await settle(); app.render();
    expect(app.state).toMatchObject({ draft: draft.text, attachments: draft.attachments, failed: true, busy: false });
    expect(app.state.error).toContain('Provider failed');
    app.opened(); await settle();
    expect(attempts).toBe(1);
  } finally { app.close(); }
});

test('a failed attachment handoff cannot start an automatic request', async () => {
  const app = harness({ text: 'Do not send without attachment', attachments: [{ kind: 'file', name: 'missing', path: '/missing' }] },
    { importAttachments: async () => { throw new Error('Attachment missing'); } });
  try {
    app.render(); await settle(); app.opened(); await settle();
    expect(app.accepted).toEqual(['Attachment missing']);
    expect(app.sends).toHaveLength(0);
  } finally { app.close(); }
});
