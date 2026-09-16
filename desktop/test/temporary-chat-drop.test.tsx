import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import { TemporaryChatSession, initialTemporaryChatState, type TemporaryChatApi } from '../frontend/src/features/chat/temporaryChatSession';
import * as transfer from '../frontend/src/features/chat/attachmentTransferModel';
import { WORKSPACE_FILE_TRANSFER_TYPE } from '../frontend/src/shared/workspaceFileTransfer';

interface Element { type: unknown; props: Record<string, unknown> }
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

function harness() {
  const imports: unknown[] = [];
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: (() => (() => void) | undefined)[] = [];
  const cleanups: (() => void)[] = [];
  let cursor = 0;
  let refCursor = 0;
  let mounted = false;
  const api: TemporaryChatApi = {
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
    send: async () => ({ text: 'Reply', model: 'model' }),
    close: async () => {},
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
      useCallback: (callback: unknown) => callback,
      useId: () => 'temporary-id',
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: (node: unknown) => node },
    'lucide-react': Object.fromEntries(['ArrowUp', 'Bot', 'LoaderCircle', 'MessageCircleDashed', 'Paperclip', 'X'].map(name => [name, name])),
    '../../cheshiDesktop': { cheshiDesktop: { temporaryChat: api } },
    '../../shared/ui': Object.fromEntries(['LiquidGlassPanel', 'LoadingState', 'NeumorphicButton', 'NeumorphicTextField', 'PillDropdownButton'].map(name => [name, name])),
    '../../shared/ui/DismissibleToast.module.css': { default: {} },
    './MessageContent': { MessageContent: 'MessageContent' },
    './ChatMessageLabel': { ChatMessageLabel: 'ChatMessageLabel' },
    './chatViewModel': { formatReasoningEffort: (effort: string) => effort },
    './temporaryChatSession': { TemporaryChatSession, initialTemporaryChatState },
    './TemporaryChatPanel.module.css': { default: {} },
    './TemporaryChatConfigurationMenu': { TemporaryChatConfigurationMenu: 'TemporaryChatConfigurationMenu' },
    './attachmentTransferModel': transfer,
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/TemporaryChatPanel.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports, document: { activeElement: null, body: {} }, crypto: { randomUUID: () => 'drop-session' }, console,
    HTMLElement: class {},
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; },
  });
  const component = exports.TemporaryChatPanel;
  assert.equal(typeof component, 'function');
  return {
    imports,
    render() {
      cursor = 0; refCursor = 0;
      const tree = (component as (props: { onClose(): void }) => unknown)({ onClose() {} });
      if (!mounted) for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
      mounted = true;
      const form = elements(tree).find(element => element.type === 'form');
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
