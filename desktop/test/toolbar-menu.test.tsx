import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolbarMenu } from '../frontend/src/shared/ui/ToolbarMenu';
import { useSplitPreviewActive } from '../frontend/src/shared/ui/splitPreviewState';
import { WorkspaceEditorFileToolbar } from '../frontend/src/features/editor/WorkspaceEditorFileToolbar';

async function withDOM(run: (h: { window: Window; render(node: ReactNode): Promise<void>; click(label: string): Promise<void> }) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await run({ window, render: async node => { await act(async () => root.render(node)); },
      click: async label => {
        const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
        if (!button) throw new Error(`Missing button: ${label}`);
        await act(async () => { button.focus(); button.click(); });
      } });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('toolbar menu supports keyboard navigation, disabled actions, closing and native surface restoration', async () => {
  await withDOM(async ({ window, render, click }) => {
    const selected: string[] = [];
    function Indicator() { return <output>{String(useSplitPreviewActive())}</output>; }
    await render(<><ToolbarMenu label="Pane actions" items={[
      { id: 'split', label: 'Split', icon: null, onSelect: () => selected.push('split') },
      { id: 'disabled', label: 'Unavailable', icon: null, disabled: true, onSelect: () => selected.push('disabled') },
      { id: 'restore', label: 'Restore', icon: null, onSelect: () => selected.push('restore') },
    ]} /><Indicator /><button aria-label="Outside">Outside</button></>);
    await click('Pane actions');
    await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
    const first = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(first);
    expect(document.querySelector('output')!.textContent).toBe('true');
    const key = async (value: string) => {
      await act(async () => document.activeElement!.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }) as unknown as Event));
    };
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Restore');
    await key('Home');
    expect(document.activeElement).toBe(first);
    await click('Unavailable');
    expect(selected).toEqual([]);
    await key('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Pane actions');
    expect(document.querySelector('output')!.textContent).toBe('false');
    await click('Pane actions');
    await click('Split');
    expect(selected).toEqual(['split']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click('Pane actions');
    await act(async () => document.querySelector('[aria-label="Outside"]')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click('Pane actions');
    await render(null);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await render(<Indicator />);
    expect(document.querySelector('output')!.textContent).toBe('false');
  });
});

type Controller = ComponentProps<typeof WorkspaceEditorFileToolbar>['controller'];
function toolbarController(calls: string[]): Controller {
  const currentFile: NonNullable<Controller['currentFile']> = {
    path: 'src/sample.ts', name: 'sample.ts', kind: 'file', fileKind: 'text', size: 100,
    modifiedAt: 1, revision: 'revision-123', hasBom: false, lineEnding: 'lf',
  };
  const server: NonNullable<Controller['activeLanguageServer']> = {
    language: 'typescript', displayName: 'TypeScript', serverName: 'ts', mode: 'auto', state: 'running', executable: null, message: '',
  };
  return {
    currentFile, activeTab: { path: currentFile.path, file: currentFile, draftContent: 'original', savedContent: 'original',
      previewDataUrl: null, sourceExcerpt: null, conflictMessage: null, loadGeneration: 1 },
    activeLanguageServer: server, languageServers: [server], codeExplanation: { explainCurrentSelection: () => { calls.push('explain'); } },
    conflictMessage: '', isDirty: false, saving: false, editorSearchOpen: false, problemsVisible: false,
    navigationAvailability: { back: false, forward: true }, navigateHistory: async direction => { calls.push(direction); },
    requestCodeActionsAtSelection: () => { calls.push('fix'); }, requestReferencesAtSelection: () => { calls.push('references'); },
    requestRenameAtSelection: () => { calls.push('rename'); }, saveFile: async () => { calls.push('save'); },
    setProblemsOpen: update => { calls.push(typeof update === 'function' ? String(update(false)) : String(update)); },
    toggleEditorSearch: () => { calls.push('search'); },
  };
}

test('file toolbar retains direct search and problems while grouping file operations and showing save only for changes', async () => {
  await withDOM(async ({ render, click }) => {
    const calls: string[] = [];
    const controller = toolbarController(calls);
    const show = () => render(<WorkspaceEditorFileToolbar controller={controller} onOpenLocalHistory={path => calls.push(path)} />);
    await show();
    expect([...document.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Find and replace', 'Open problems panel', 'File actions']);
    expect(document.querySelector('strong')?.title).toContain('revision-123');
    expect(document.body.textContent).not.toContain('revision-123');
    await click('Find and replace');
    await click('Open problems panel');
    expect(calls).toEqual(['search', 'true']);
    await click('File actions');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Navigate back"]')!.disabled).toBe(true);
    await click('Navigate back');
    expect(calls).toHaveLength(2);
    await click('Navigate forward');
    for (const label of ['Local history', 'Find symbol references', 'Show quick fixes', 'Rename symbol', 'Explain selected code']) {
      await click('File actions');
      await click(label);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }
    expect(calls).toEqual(['search', 'true', 'forward', 'src/sample.ts', 'references', 'fix', 'rename', 'explain']);
    controller.isDirty = true;
    await show();
    await click('Save file');
    expect(calls.at(-1)).toBe('save');
    controller.conflictMessage = 'Changed on disk';
    await show();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Save file"]')!.disabled).toBe(true);
    controller.conflictMessage = '';
    controller.saving = true;
    await show();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Save file"]')!.disabled).toBe(true);
    controller.saving = false;
    controller.isDirty = false;
    await show();
    expect(document.querySelector('[aria-label="Save file"]')).toBeNull();
  });
});

test('file menu respects read-only excerpts and unavailable language servers', async () => {
  await withDOM(async ({ render, click }) => {
    const controller = toolbarController([]);
    controller.activeTab!.sourceExcerpt = { file: controller.currentFile!, content: '', startLine: 10, endLine: 20,
      targetLine: 12, hasMoreBefore: true, hasMoreAfter: true };
    controller.languageServers = [];
    await render(<WorkspaceEditorFileToolbar controller={controller} onOpenLocalHistory={() => {}} />);
    await click('File actions');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Local history"]')!.disabled).toBe(true);
    expect(document.querySelector('[aria-label="Find symbol references"]')).toBeNull();
    expect(document.querySelector('[aria-label="Rename symbol"]')).toBeNull();
    expect(document.querySelector('[aria-label="Show quick fixes"]')).toBeNull();
  });
});

test('opening the file menu closes the pane menu and clicking its trigger again closes it', async () => {
  await withDOM(async ({ window, render, click }) => {
    const items = [{ id: 'one', label: 'Action', icon: null, onSelect() {} }];
    await render(<><ToolbarMenu label="Pane actions" items={items} /><ToolbarMenu label="File actions" items={items} /></>);
    await click('Pane actions');
    const file = document.querySelector<HTMLButtonElement>('[aria-label="File actions"]')!;
    const pointerClick = async () => {
      await act(async () => file.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event));
      await act(async () => file.click());
    };
    await pointerClick();
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('File actions');
    await pointerClick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

test('right sidebar remains available in the file menu only when a review can be shown', async () => {
  const { SidebarToggleVisibility } = await import('../frontend/src/shared/ui/SidebarToggle');
  await withDOM(async ({ render, click }) => {
    const controller = toolbarController([]);
    let toggles = 0;
    const show = (visible: boolean, open: boolean) => render(<SidebarToggleVisibility.Provider value={visible}>
      <WorkspaceEditorFileToolbar controller={controller} rightSidebarOpen={open} onToggleRightSidebar={() => { toggles++; }} />
    </SidebarToggleVisibility.Provider>);
    await show(true, false);
    expect(document.querySelector('[aria-label="Open right sidebar"]')).toBeNull();
    await click('File actions');
    await click('Open right sidebar');
    expect(toggles).toBe(1);
    await show(true, true);
    await click('File actions');
    await click('Close right sidebar');
    expect(toggles).toBe(2);
    await show(false, false);
    await click('File actions');
    expect(document.querySelector('[aria-label="Open right sidebar"]')).toBeNull();
    expect(document.querySelector('[aria-label="Close right sidebar"]')).toBeNull();
  });
});
