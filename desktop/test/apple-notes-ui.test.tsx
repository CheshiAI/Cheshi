import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as contract from '../shared/apple-notes';
import type { AppleNotesBrowserState } from '../frontend/src/features/notes/appleNotesModel';
import type { AppleNotesSaveDialog } from '../frontend/src/features/notes/AppleNotesSaveAction';
import type { AppleNotesBrowser } from '../frontend/src/features/notes/AppleNotesBrowser';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const note: contract.AppleNote = { id: 'note', title: '<script>title</script>', plaintext: '<img src=x onerror=alert(1)>',
  modifiedAt: '2026-09-16T00:00:00Z', locked: false };
function state(): AppleNotesBrowserState {
  return { folders: [{ id: 'folder', name: 'Notes', account: 'iCloud', path: 'Notes', isDefault: true }],
    folderId: 'folder', notes: [note], selectedId: note.id, note, nextOffset: null,
    loadingFolders: false, loadingNotes: false, loadingNote: false, error: null };
}
function api(create: contract.AppleNotesApi['create']): contract.AppleNotesApi {
  return { available: true, folders: async () => [], list: async () => ({ notes: [], nextOffset: null }), read: async () => note, create };
}

function harness<T>(file: string, symbol: string, browserState = state()) {
  const slots: unknown[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  const modules: Record<string, unknown> = {
    react: {
      useRef(current: unknown) { return slots[cursor++] ??= { current }; },
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useId() { return 'test-id'; },
      useEffect(effect: () => () => void) {
        const index = cursor++;
        if (!(index in slots)) { slots[index] = true; effects.push(effect()); }
      },
    },
    'react/jsx-runtime': jsx,
    'lucide-react': { Check: 'check-icon', StickyNote: 'note-icon', RefreshCw: 'refresh-icon', LockKeyhole: 'lock-icon' },
    '../../../../shared/apple-notes': contract,
    '../../cheshiDesktop': { cheshiDesktop: undefined },
    '../../shared/ui': { LiquidGlassPanel: 'section', Modal: 'modal', NeumorphicButton: 'button', NeumorphicTextField: 'input', Tooltip: 'tooltip', SearchClearButton: 'clear-button' },
    './AppleNotesFolderField': { AppleNotesFolderField: 'folder-field' },
    './AppleNotes.module.css': { default: {} },
    './useAppleNotesBrowser': { useAppleNotesBrowser: () => ({ state: browserState, browser: {
      refresh: async () => {}, selectFolder: async () => {}, loadMore: async () => {}, selectNote: async () => {},
    } }) },
  };
  const source = readFileSync(new URL(`../frontend/src/features/notes/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, require(name: string) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
    return modules[name];
  } });
  return {
    render(run: (component: T) => ReactNode) { cursor = 0; return run(exports[symbol] as T); },
    unmount() { effects.forEach(cleanup => cleanup()); },
  };
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    return [child, ...elements(child.props.children as ReactNode)];
  });
}
function find(node: ReactNode, predicate: (element: ReactElement<Record<string, unknown>>) => boolean) {
  const element = elements(node).find(predicate);
  if (!element) throw new Error('Expected UI element was not rendered.');
  return element;
}
function submit(node: ReactNode) {
  const form = find(node, element => element.type === 'form');
  if (typeof form.props.onSubmit !== 'function') throw new Error('Missing submit handler.');
  form.props.onSubmit({ preventDefault() {} });
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('saving a response submits exactly once and waits for acknowledgement before closing', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteCreated>>();
  const calls: contract.AppleNoteCreateInput[] = [];
  let saved = 0;
  const props = { api: api(async input => { calls.push(input); return pending.promise; }),
    initialTitle: 'Conversation', body: 'Answer', onClose() {}, onSaved() { saved += 1; } };
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveAction.tsx', 'AppleNotesSaveDialog');
  const render = () => app.render(component => component(props));
  const tree = render();
  submit(tree); submit(tree);
  expect(calls).toEqual([{ folderId: 'folder', title: 'Conversation', body: 'Answer' }]);
  expect(saved).toBe(0);
  expect(find(render(), element => element.type === 'modal').props.closeDisabled).toBe(true);
  pending.resolve({ ok: true, value: { id: 'created', title: 'Conversation' } });
  await flush();
  expect(saved).toBe(1);
});

test('an uncertain save shows its message and prevents an immediate duplicate retry', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteCreated>>();
  let calls = 0;
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveAction.tsx', 'AppleNotesSaveDialog');
  const render = () => app.render(component => component({ api: api(async () => { calls += 1; return pending.promise; }),
    initialTitle: 'Conversation', body: 'Answer', onClose() {}, onSaved() { throw new Error('Unexpected success'); } }));
  submit(render());
  pending.resolve({ ok: false, error: { code: 'save-unknown', message: 'Check Notes before saving again.' } });
  await flush();
  const tree = render();
  expect(find(tree, element => element.props.role === 'alert').props.children).toBe('Check Notes before saving again.');
  expect(find(tree, element => element.props.type === 'submit').props.disabled).toBe(true);
  submit(tree);
  expect(calls).toBe(1);
});

test('saving does not close a different view after its dialog unmounts', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteCreated>>();
  let saved = 0;
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveAction.tsx', 'AppleNotesSaveDialog');
  submit(app.render(component => component({ api: api(async () => pending.promise), initialTitle: 'Conversation', body: 'Answer',
    onClose() {}, onSaved() { saved += 1; } })));
  app.unmount();
  pending.resolve({ ok: true, value: { id: 'created', title: 'Conversation' } });
  await flush();
  expect(saved).toBe(0);
});

test('notes page previews untrusted content as text and waits for attachment acknowledgement', async () => {
  const pending = createDeferred<boolean>();
  const attached: contract.AppleNote[] = [];
  let completed = 0;
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser');
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'Title' } })),
    onAttach: async value => { attached.push(value); const result = await pending.promise; if (result) completed += 1; return result; } }));
  const tree = render();
  expect(renderToStaticMarkup(find(tree, element => element.type === 'pre'))).toContain('&lt;img src=x onerror=alert(1)&gt;');
  const button = find(tree, element => element.props.children === '대화에 첨부');
  if (typeof button.props.onClick !== 'function') throw new Error('Missing attachment action.');
  button.props.onClick(); button.props.onClick();
  expect(attached).toEqual([note]);
  expect(completed).toBe(0);
  pending.resolve(true);
  await flush();
  expect(completed).toBe(1);
});

test('notes page keeps the preview and shows an error when attachment is refused', async () => {
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser');
  let calls = 0;
  let attachmentDisabled = true;
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'Title' } })),
    attachmentDisabled, onAttach: async () => { calls += 1; return false; } }));
  const button = find(render(), element => element.props.children === '대화에 첨부');
  expect(button.props.disabled).toBe(true);
  if (typeof button.props.onClick !== 'function') throw new Error('Missing attachment action.');
  button.props.onClick();
  expect(calls).toBe(0);
  attachmentDisabled = false;
  const enabled = find(render(), element => element.props.children === '대화에 첨부');
  if (typeof enabled.props.onClick !== 'function') throw new Error('Missing attachment action.');
  enabled.props.onClick();
  await flush();
  expect(calls).toBe(1);
  expect(find(render(), element => element.props.role === 'alert').props.children).toContain('Could not attach');
  expect(find(render(), element => element.type === 'pre').props.children).toBe(note.plaintext);
});
