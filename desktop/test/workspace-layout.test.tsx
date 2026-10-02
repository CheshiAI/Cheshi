import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as terminalModel from '../frontend/src/features/terminal/model';
import type { TerminalController, useTerminalController } from '../frontend/src/features/terminal/useTerminalController';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactNode } from 'react';
import { parseWorkspaceLayout, placeWorkspacePane, visibleWorkspaceLayout, workspaceDropDirection } from '../frontend/src/features/shell/workspaceLayoutModel';
import { splitPaneIds, type SplitLayoutNode } from '../frontend/src/shared/ui/splitPaneModel';
import { beginSplitPreview } from '../frontend/src/shared/ui/splitPreviewState';

mock.module('../frontend/src/shared/ui/SplitPaneLayout.module.css', () => ({ default: { split: 'split', region: 'region', separator: 'separator' } }));
mock.module('../frontend/src/shared/ui/Tooltip.module.css', () => ({ default: { anchor: 'tooltip-anchor', content: 'tooltip-content' } }));
const { WorkspaceEditorSplit } = await import('../frontend/src/features/shell/WorkspaceEditorSplit');
const { WorkspaceLayoutControls, workspacePaneDragType } = await import('../frontend/src/features/shell/WorkspaceLayoutControls');
const { SplitPreview } = await import('../frontend/src/shared/ui/SplitPreview');
const { useSplitPreviewActive } = await import('../frontend/src/shared/ui/splitPreviewState');

async function withDOM(run: (h: { window: Window; render(node: ReactNode): Promise<void>; click(label: string): Promise<void>; resize(target: Element): Promise<void> }) => Promise<void>) {
  const window = new Window();
  const observers = new Set<{ targets: Set<Element>; notify(): void }>();
  const globals = { Node: window.Node, HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      readonly targets = new Set<Element>();
      readonly notify: () => void;
      constructor(notify: () => void) { this.notify = notify; }
      observe(target: Element) { this.targets.add(target); observers.add(this); }
      disconnect() { this.targets.clear(); observers.delete(this); }
      unobserve(target: Element) { this.targets.delete(target); }
    } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const bounds = new window.DOMRect(0, 0, 1200, 800);
  window.HTMLElement.prototype.getBoundingClientRect = () => bounds;
  const container = document.createElement('div');
  const toolbar = document.createElement('div');
  toolbar.id = 'workspace-layout-controls';
  document.body.append(container, toolbar);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  try {
    await run({ window, render: async node => { await act(async () => root.render(node)); },
      resize: async target => { await act(async () => {
        for (const observer of [...observers]) if (observer.targets.has(target)) observer.notify();
      }); },
      click: async label => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find(candidate => candidate.getAttribute('aria-label') === label || candidate.textContent?.startsWith(label));
        if (!button) throw new Error(`Missing button: ${label}`);
        await act(async () => { button.focus(); button.click(); });
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function Fixture({ opened }: { opened: string[] }) {
  const [layout, setLayout] = useState<SplitLayoutNode | null>(null);
  const area = (name: string) => <section data-content={name}>
    <WorkspaceLayoutControls /><input aria-label={`${name} draft`} defaultValue="unsaved" />
  </section>;
  return <WorkspaceEditorSplit mode="split" layout={layout} onLayoutChange={setLayout}
    onOpenPane={id => opened.push(id)}
    editor={area('editor')} terminal={area('terminal')}>{area('primary')}</WorkspaceEditorSplit>;
}

test('workspace reserves the Codex minimum through nested rows and restored split ratios', async () => {
  await withDOM(async ({ render, window }) => {
    const changes: SplitLayoutNode[] = [];
    const layout: SplitLayoutNode = { type: 'split', id: 'outer', axis: 'columns', ratio: .9,
      first: { type: 'pane', paneId: 'editor' },
      second: { type: 'split', id: 'stack', axis: 'rows', ratio: .5,
        first: { type: 'pane', paneId: 'primary' }, second: { type: 'pane', paneId: 'terminal' } } };
    const show = (minimumPrimaryWidth: number | undefined, current: SplitLayoutNode = layout) => render(
      <WorkspaceEditorSplit mode="split" layout={current} minimumPrimaryWidth={minimumPrimaryWidth}
        onLayoutChange={value => changes.push(value)} editor={<input aria-label="File draft" defaultValue="unsaved" />}
        terminal={<div>Terminal</div>}><input aria-label="Chat draft" defaultValue="unsent" /></WorkspaceEditorSplit>);
    await show(475);
    const chat = document.querySelector<HTMLInputElement>('[aria-label="Chat draft"]')!;
    chat.value = 'keep draft';
    const outer = document.querySelector<HTMLElement>('[data-axis="columns"]')!;
    expect(outer.style.gridTemplateColumns).toBe('minmax(120px, 90fr) 1px minmax(475px, 10fr)');
    expect(outer.style.minWidth).toBe('596px');
    expect(outer.parentElement?.style.minWidth).toBe('596px');
    const stack = outer.querySelector<HTMLElement>('[data-axis="rows"]')!;
    expect(stack.style.minWidth).toBe('475px');
    expect(stack.style.gridTemplateRows).toBe('minmax(0px, 50fr) 1px minmax(0px, 50fr)');
    const separator = outer.querySelector(':scope > [role="separator"]')!;
    await act(async () => { separator.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }) as unknown as Event); });
    const changed = changes.at(-1)!;
    if (changed.type !== 'split') throw new Error('Expected resized workspace split');
    expect((1 - changed.ratio) * 1199).toBeCloseTo(475);
    await show(undefined);
    expect(outer.style.minWidth).toBe('');
    expect(outer.parentElement?.style.minWidth).toBe('');
    expect(document.querySelector('[aria-label="Chat draft"]')).toBe(chat);
    expect(chat.value).toBe('keep draft');
    await show(475, { type: 'pane', paneId: 'primary' });
    expect(document.querySelector<HTMLElement>('[data-workspace-pane="primary"]')?.parentElement?.style.minWidth).toBe('475px');
    expect(document.querySelector('[aria-label="Chat draft"]')).toBe(chat);
    await show(475, { type: 'pane', paneId: 'editor' });
    expect(document.querySelector<HTMLElement>('[data-workspace-pane="editor"]')?.parentElement?.style.minWidth).toBe('');
  });
});

test.each(['right', 'down'] as const)('pane %s preview cancels without opening or resizing and commits the selected area', async direction => {
  await withDOM(async ({ render, click, window }) => {
    const opened: string[] = [];
    await render(<Fixture opened={opened} />);
    const input = document.querySelector<HTMLInputElement>('[aria-label="editor draft"]')!;
    input.value = 'keep my draft';
    const editorHost = input.closest('[data-workspace-pane]')!;
    const initialStyle = editorHost.parentElement?.parentElement?.getAttribute('style');
    await click(`Split area ${direction}`);
    expect(opened).toEqual([]);
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    expect(document.querySelector('dialog')?.getAttribute('data-backdrop')).toBe('regional');
    expect(document.querySelector('dialog [data-liquid-glass-backdrop]')?.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(editorHost.parentElement?.parentElement?.getAttribute('style')).toBe(initialStyle);
    await act(async () => document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true }) as unknown as Event));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`Split area ${direction}`);
    expect(opened).toEqual([]);
    await click(`Split area ${direction}`);
    await click('Terminal');
    expect(opened).toEqual(['terminal']);
    expect(document.querySelector('dialog')).toBeNull();
    const terminalHost = document.querySelector('[data-workspace-pane="terminal"]')!;
    expect(terminalHost.closest('[hidden]')).toBeNull();
    expect(terminalHost.parentElement?.parentElement?.getAttribute('data-axis')).toBe(direction === 'right' ? 'columns' : 'rows');
    expect(document.querySelector('[aria-label="editor draft"]')).toBe(input);
    expect(input.value).toBe('keep my draft');
    await click('Maximize pane');
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('keep my draft');
    await click('Restore pane size');
    expect(input.value).toBe('keep my draft');
  });
});

test('moving an existing area preserves identity and leaves each pane in the layout exactly once', () => {
  const original = visibleWorkspaceLayout('split', false);
  const withTerminal = placeWorkspacePane(original, 'workspace', 'terminal', 'down');
  const moved = placeWorkspacePane(withTerminal, 'editor', 'primary', 'down');
  expect(splitPaneIds(moved)).toEqual(['editor', 'primary', 'terminal']);
  expect(new Set(splitPaneIds(moved)).size).toBe(3);
  expect(moved).toMatchObject({ axis: 'rows', first: { axis: 'rows' } });
  expect(placeWorkspacePane(moved, 'editor', 'editor', 'right')).toBe(moved);
  expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
  expect(parseWorkspaceLayout({ ...withTerminal, second: { type: 'pane', paneId: 'editor' } })).toBeNull();
  expect(parseWorkspaceLayout({ ...withTerminal, ratio: NaN })).toBeNull();
  expect(parseWorkspaceLayout({ type: 'pane', paneId: 'unknown' })).toBeNull();
});

test('failed opening keeps the chooser available for retry and never commits the preview', async () => {
  await withDOM(async ({ render, click }) => {
    const target = document.createElement('section');
    document.body.append(target);
    let attempts = 0, closed = 0;
    await render(<SplitPreview target={target} direction="right" title="Split"
      choices={[{ id: 'terminal', label: 'Terminal', icon: null }]}
      onChoose={async () => { attempts++; return false; }} onClose={() => { closed++; }} />);
    await click('Terminal');
    expect(attempts).toBe(1);
    expect(closed).toBe(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be opened');
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    await click('Terminal');
    expect(attempts).toBe(2);
  });
});

test('native surface occlusion remains active until all split previews end', async () => {
  await withDOM(async ({ render }) => {
    function Indicator() { return <output>{String(useSplitPreviewActive())}</output>; }
    await render(<Indicator />);
    let endFirst!: () => void, endSecond!: () => void;
    await act(async () => { endFirst = beginSplitPreview(); endSecond = beginSplitPreview(); });
    expect(document.querySelector('output')!.textContent).toBe('true');
    await act(async () => endFirst());
    expect(document.querySelector('output')!.textContent).toBe('true');
    await act(async () => endSecond());
    expect(document.querySelector('output')!.textContent).toBe('false');
  });
});

test('pane split previews only the chosen area and rejects a pane that would be too small', async () => {
  await withDOM(async ({ render, click, window }) => {
    const target = document.createElement('section');
    document.body.append(target);
    target.getBoundingClientRect = () => new window.DOMRect(0, 0, 300, 180) as unknown as DOMRect;
    let opened = false;
    await render(<SplitPreview target={target} direction="right" title="Split small pane"
      choices={[{ id: 'terminal', label: 'Terminal', icon: null }]}
      onChoose={() => { opened = true; return true; }} onClose={() => {}} />);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('larger');
    await click('Terminal');
    expect(opened).toBe(false);
  });
});

test('double activation while opening creates only one pane', async () => {
  await withDOM(async ({ render, click }) => {
    const target = document.createElement('section');
    document.body.append(target);
    let finish!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { finish = resolve; });
    let count = 0;
    await render(<SplitPreview target={target} direction="right" title="Split"
      choices={[{ id: 'terminal', label: 'Terminal', icon: null }]}
      onChoose={() => { count++; return pending; }} onClose={() => {}} />);
    await click('Terminal');
    await click('Terminal');
    expect(count).toBe(1);
    await act(async () => finish(false));
  });
});

test('terminal preview hides native surfaces without sending transformed bounds or starting another process', async () => {
  await withDOM(async ({ render, window }) => {
    const visibility: boolean[] = [];
    const bounds: unknown[] = [];
    const frames: FrameRequestCallback[] = [];
    const scheduleFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { frames.push(callback as FrameRequestCallback); return scheduleFrame(() => {}); };
    const api = {
      onTerminalStateChanged() { return () => {}; },
      async setTerminalViewVisible(visible: boolean) { visibility.push(visible); return terminalModel.EMPTY_TERMINAL_STATE; },
      updateTerminalSurfaceBounds(value: unknown) { bounds.push(value); },
    };
    const exports: { useTerminalController?: typeof useTerminalController } = {};
    const modules: Record<string, unknown> = { react: React, '../../cheshiDesktop': { cheshiDesktop: api }, './model': terminalModel };
    const source = readFileSync(new URL('../frontend/src/features/terminal/useTerminalController.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
    vm.runInNewContext(compiled.outputText, { exports, window, ResizeObserver,
      require(name: string) { if (!(name in modules)) throw new Error(`Unexpected module: ${name}`); return modules[name]; } });
    const useController = exports.useTerminalController!;
    let controller!: TerminalController;
    function Capture({ preview }: { preview: boolean }) { controller = useController(true, preview); return null; }
    const flush = () => { frames.splice(0).forEach(callback => callback(0)); };
    const host = document.createElement('div');
    document.body.append(host);
    await render(<Capture preview={false} />);
    controller.registerHost('pane', host);
    flush();
    const before = bounds.length;
    await render(<Capture preview />);
    flush();
    expect(visibility.at(-1)).toBe(false);
    expect(bounds).toHaveLength(before);
    await render(<Capture preview={false} />);
    flush();
    expect(visibility.at(-1)).toBe(true);
    expect(bounds.length).toBeGreaterThan(before);
    expect(bounds.at(-1)).toMatchObject({ width: 1200, height: 800 });
  });
});

test('editor hover and blame tooltips leave native terminal visibility unchanged', async () => {
  const { Compartment, EditorState } = await import('@codemirror/state');
  const { EditorView, showTooltip } = await import('@codemirror/view');
  const { workspaceEditorTooltips } = await import('../frontend/src/features/editor/workspaceEditorTooltips');
  const { attachGitLineBlameTooltip } = await import('../frontend/src/features/editor/gitLineBlameTooltip');
  await withDOM(async ({ render, window }) => {
    const hiddenStates: boolean[] = [];
    function Capture() {
      hiddenStates.push(useSplitPreviewActive());
      return null;
    }
    await render(<Capture />);
    const host = document.createElement('div');
    const anchor = document.createElement('span');
    document.body.append(host, anchor);
    const slot = new Compartment();
    const view = new EditorView({ parent: host, state: EditorState.create({
      doc: 'const child: string', extensions: [workspaceEditorTooltips(document), slot.of([])],
    }) });
    const cleanupBlame = attachGitLineBlameTooltip(anchor, {
      status: 'committed', hash: 'a'.repeat(40), author: 'Author', authoredAt: '2026-09-19T00:00:00.000Z',
      summary: 'Change', originalLine: 1, originalPath: 'sample.ts',
    });
    let releasePreview: (() => void) | undefined;
    const show = async () => {
      await act(async () => {
        view.dispatch({ effects: slot.reconfigure(showTooltip.of({ pos: 0, arrow: true, create() {
          const dom = document.createElement('div');
          dom.textContent = 'const child: string';
          return { dom };
        } })) });
        anchor.dispatchEvent(new window.FocusEvent('focus') as unknown as Event);
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      expect(document.querySelector('.cm-tooltip')?.textContent).toContain('const child: string');
      expect(document.querySelector('.git-line-blame-tooltip')).not.toBeNull();
    };
    const dismiss = async () => {
      await act(async () => {
        view.dispatch({ effects: slot.reconfigure([]) });
        anchor.dispatchEvent(new window.FocusEvent('blur') as unknown as Event);
        await new Promise(resolve => setTimeout(resolve, 50));
      });
    };
    try {
      await show();
      expect(hiddenStates).toEqual([false]);
      await dismiss();
      expect(hiddenStates).toEqual([false]);
      await act(async () => { releasePreview = beginSplitPreview(); });
      await show();
      await dismiss();
      expect(hiddenStates.at(-1)).toBe(true);
      await act(async () => { releasePreview?.(); releasePreview = undefined; });
      expect(hiddenStates.at(-1)).toBe(false);
      await show();
      hiddenStates.length = 0;
      await act(async () => { cleanupBlame(); view.destroy(); });
      expect(hiddenStates).toEqual([]);
    } finally {
      await act(async () => { cleanupBlame(); view.destroy(); releasePreview?.(); });
    }
  });
});

test.each(['right', 'down'] as const)('terminal %s split explains size limits before opening, rechecks the preview and restores on cancel', async direction => {
  const { TerminalPaneLayout } = await import('../frontend/src/features/terminal/TerminalPaneLayout');
  const { insertSplitPane } = await import('../frontend/src/shared/ui/splitPaneModel');
  await withDOM(async ({ render, click, window, resize }) => {
    const hosts = new Map<string, HTMLElement>();
    const removals: string[] = [];
    let created = 0;
    const registerHost = (id: string, host: HTMLElement | null) => {
      if (host) hosts.set(id, host);
      else removals.push(id);
    };
    function TerminalFixture() {
      const [layout, setLayout] = useState<SplitLayoutNode>({ type: 'pane', paneId: 'first' });
      const panes = splitPaneIds(layout).map(id => ({ id, title: '/workspace', running: true }));
      return <div className="app-shell"><TerminalPaneLayout layout={layout} panes={panes} activePaneId="first" registerHost={registerHost}
        onSelectPane={() => {}} onResizeSplit={() => {}} onClosePane={() => {}}
        onSplitPane={async (id, direction) => {
          created++;
          setLayout(current => insertSplitPane(current, id, 'second', direction, 'split'));
          return true;
        }} /></div>;
    }
    await render(<TerminalFixture />);
    const original = hosts.get('first');
    const pane = document.querySelector<HTMLElement>('.terminal-pane')!;
    const originalClass = pane.className;
    const scene = document.querySelector<HTMLElement>('.app-shell')!;
    scene.style.filter = 'brightness(1)';
    let width = direction === 'right' ? 474 : 280;
    let height = direction === 'right' ? 800 : 399;
    pane.getBoundingClientRect = () => new window.DOMRect(0, 0, width, height);
    const choice = () => [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
      .find(button => button.textContent?.startsWith('Terminal'))!;
    const trigger = pane.querySelector<HTMLButtonElement>(`[aria-label="Split pane ${direction}"]`)!;
    await resize(pane);
    expect(trigger.disabled).toBe(true);
    const reason = direction === 'right'
      ? 'Split pane right requires an area at least 475px wide and 240px high.'
      : 'Split pane down requires an area at least 280px wide and 400px high.';
    expect(trigger.getAttribute('aria-description')).toBe(reason);
    await click(`Split pane ${direction}`);
    expect(document.querySelector('dialog')).toBeNull();
    expect(created).toBe(0);
    await act(async () => { trigger.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }) as unknown as Event); });
    await act(async () => { await new Promise<void>(resolve => window.setTimeout(resolve, 1000)); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(reason);
    await act(async () => { trigger.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }) as unknown as Event); });
    width = direction === 'right' ? 475 : 280;
    height = direction === 'right' ? 800 : 400;
    await resize(pane);
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-description')).toBe(`Split pane ${direction}`);
    await click(`Split pane ${direction}`);
    expect(choice().disabled).toBe(false);
    width = direction === 'right' ? 474 : 280;
    height = direction === 'right' ? 800 : 399;
    await resize(pane);
    expect(choice().disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('larger');
    await click('Terminal');
    expect(created).toBe(0);
    width = direction === 'right' ? 475 : 280;
    height = direction === 'right' ? 800 : 400;
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    expect(choice().disabled).toBe(false);
    expect(document.querySelector('dialog')?.getAttribute('data-backdrop')).toBe('regional');
    expect(document.querySelector('dialog [data-liquid-glass-backdrop]')?.getAttribute('data-regional-blur-surface')).toBe('true');
    await click('Cancel');
    expect(created).toBe(0);
    expect(document.querySelector('dialog')).toBeNull();
    expect(scene.style.filter).toBe('brightness(1)');
    expect(scene.hasAttribute('data-regional-blur-source')).toBe(false);
    expect(pane.className).toBe(originalClass);
    expect(hosts.get('first')).toBe(original);
    await click(`Split pane ${direction}`);
    await click('Terminal');
    expect(created).toBe(1);
    expect(hosts.get('first')).toBe(original);
    expect(removals).toEqual([]);
    expect(hosts.has('second')).toBe(true);
    expect(document.querySelector('dialog')).toBeNull();
  });
});

test('chat split chooser preserves the new-session and fork operations and blocks a changed source', async () => {
  const { ChatSplitDialog } = await import('../frontend/src/features/chat/ChatSplitDialog');
  await withDOM(async ({ render, click, window }) => {
    const target = document.createElement('section');
    document.body.append(target);
    const calls: unknown[][] = [];
    const workspace = {
      splitPending: false, paneIds: ['chat'], relay: { running: false, state: null },
      controllers: { chat: { state: { activeSessionId: 'thread', phase: 'idle', pendingNewResponse: false, responseThreadIds: [], approvals: [] } } },
      async splitPane(...args: unknown[]) { calls.push(args); return false; },
    };
    const renderChoice = (sourceThreadId: string) => render(<ChatSplitDialog
      workspace={workspace as unknown as import('../frontend/src/features/chat/useChatWorkspace').ChatWorkspaceController}
      paneId="chat" sourceThreadId={sourceThreadId} target={target} onClose={() => {}} />);
    target.getBoundingClientRect = () => new window.DOMRect(0, 0, 475, 800);
    await renderChoice('thread');
    expect(calls).toEqual([]);
    await click('New session');
    expect(calls.at(-1)).toEqual(['chat', 'new', 'thread']);
    await click('Fork current conversation');
    expect(calls.at(-1)).toEqual(['chat', 'fork', 'thread']);
    await renderChoice('different-thread');
    await click('Fork current conversation');
    expect(calls).toHaveLength(2);
    workspace.paneIds = ['chat', ...Array.from({ length: 9 }, (_, index) => `pane-${index}`)];
    await renderChoice('thread');
    await click('New session');
    await click('Fork current conversation');
    expect(calls).toHaveLength(2);
    workspace.paneIds.pop();
    await renderChoice('thread');
    await click('New session');
    await click('Fork current conversation');
    expect(calls).toHaveLength(4);
  });
});

test.each(['chat', 'right', 'down'] as const)('%s split blurs only the destination footprint and restores the scene on cancel', async mode => {
  const { ChatSplitDialog } = await import('../frontend/src/features/chat/ChatSplitDialog');
  await withDOM(async ({ render, click, window }) => {
    const scene = document.createElement('div'), target = document.createElement('section');
    scene.className = 'app-shell';
    scene.style.filter = 'brightness(1)';
    scene.append(target);
    document.body.append(scene);
    Object.defineProperties(scene, { offsetWidth: { value: 1200 }, offsetHeight: { value: 800 } });
    const draft = document.createElement('textarea');
    draft.value = 'Preserve my draft';
    target.append(draft);
    const workspace = {
      splitPending: false, paneIds: ['chat'], relay: { running: false, state: null }, controllers: {},
      async splitPane() { return true; },
    };
    function Preview() {
      const [open, setOpen] = useState(true);
      if (!open) return null;
      if (mode !== 'chat') return <SplitPreview target={target} direction={mode} title="Split" backdrop="regional"
        choices={[{ id: 'editor', label: 'Editor', icon: null }]} onChoose={() => true} onClose={() => setOpen(false)} />;
      return <ChatSplitDialog
        workspace={workspace as unknown as import('../frontend/src/features/chat/useChatWorkspace').ChatWorkspaceController}
        paneId="chat" sourceThreadId={null} target={target} onClose={() => setOpen(false)} />;
    }
    await render(<Preview />);
    const panel = document.querySelector<HTMLElement>('dialog [data-liquid-glass-backdrop]')!;
    expect(scene.contains(panel)).toBe(false);
    expect(panel.getAttribute('data-regional-blur-surface')).toBe('true');
    const bounds = mode === 'down'
      ? { x: 40, y: 420, width: 1120, height: 340, top: 420, left: 40, right: 1160, bottom: 760, toJSON() { return {}; } }
      : { x: 620, y: 40, width: 540, height: 720, top: 40, left: 620, right: 1160, bottom: 760, toJSON() { return {}; } };
    panel.getBoundingClientRect = () => bounds;
    panel.getClientRects = () => ({ 0: bounds, length: 1, item: () => bounds, [Symbol.iterator]: () => [bounds][Symbol.iterator]() });
    panel.style.cssText = 'display:flex;visibility:visible;opacity:1;border-radius:16px';
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'));
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    });
    expect(scene.style.filter).toContain('url(');
    expect(target.style.filter).toBe('');
    expect(panel.style.filter).toBe('');
    const filter = document.getElementById(scene.getAttribute('data-regional-blur-source')!)!;
    const mask = decodeURIComponent(filter.querySelector('feImage')!.getAttribute('href')!.split(',').slice(1).join(','));
    expect(mask.match(/<path /g)).toHaveLength(1);
    expect(mask).toContain(mode === 'down' ? 'M56 420H1144' : 'M636 40H1144');
    expect(filter.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    await click('Cancel');
    expect(document.querySelector('dialog')).toBeNull();
    expect(scene.style.filter).toBe('brightness(1)');
    expect(scene.hasAttribute('data-regional-blur-source')).toBe(false);
    expect(target.className).toBe('');
    expect(draft.isConnected).toBe(true);
    expect(draft.value).toBe('Preserve my draft');
  });
});

test('hiding and reopening the primary area transfers focus and retains both portal contents', async () => {
  await withDOM(async ({ render }) => {
    const editor = <input aria-label="saved editor" defaultValue="file draft" />;
    const primary = <button>Close primary</button>;
    await render(<WorkspaceEditorSplit mode="split" editor={editor}>{primary}</WorkspaceEditorSplit>);
    const button = document.querySelector<HTMLButtonElement>('button')!;
    const input = document.querySelector<HTMLInputElement>('input')!;
    button.focus();
    await render(<WorkspaceEditorSplit mode="editor" editor={editor}>{primary}</WorkspaceEditorSplit>);
    expect(document.activeElement?.contains(input)).toBe(true);
    expect(button.closest('[hidden]')).not.toBeNull();
    await render(<WorkspaceEditorSplit mode="split" editor={editor}>{primary}</WorkspaceEditorSplit>);
    expect(document.querySelector('input')).toBe(input);
    expect(document.querySelector('button')).toBe(button);
    expect(button.closest('[hidden]')).toBeNull();
    expect(input.value).toBe('file draft');
  });
});

const dropPoints = { left: [60, 400], right: [1140, 400], up: [600, 40], down: [600, 760] } as const;

async function dispatchDrag(window: Window, target: Element, type: string, transfer: InstanceType<Window['DataTransfer']>,
  point: readonly [number, number] = [600, 400]) {
  const event = new window.DragEvent(type, { bubbles: true, cancelable: true });
  // Happy DOM's DragEvent does not yet expose the browser's pointer coordinates.
  Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: point[0] }, clientY: { value: point[1] } });
  await act(async () => target.dispatchEvent(event as unknown as Event));
  return event;
}

test.each(['left', 'right', 'up', 'down'] as const)('dragging portaled content to the %s edge repositions the pane and retains drafts', async direction => {
  await withDOM(async ({ render, window }) => {
    function Indicator() { return <output>{String(useSplitPreviewActive())}</output>; }
    await render(<><Fixture opened={[]} /><Indicator /></>);
    const input = document.querySelector<HTMLInputElement>('[aria-label="editor draft"]')!;
    const target = document.querySelector<HTMLInputElement>('[aria-label="primary draft"]')!;
    const targetMount = target.closest('[data-workspace-pane]')!;
    const handle = input.parentElement!.querySelector('[draggable]')!;
    input.value = 'preserved across reparenting';
    const transfer = new window.DataTransfer();
    await dispatchDrag(window, handle, 'dragstart', transfer);
    expect(transfer.getData(workspacePaneDragType)).toBe('editor');
    expect(document.querySelector('output')!.textContent).toBe('true');
    // Native events must reach the DOM parent even though content is in a React portal.
    const over = await dispatchDrag(window, target, 'dragover', transfer, dropPoints[direction]);
    expect(over.defaultPrevented).toBe(true);
    expect(targetMount.getAttribute('data-drop')).toBe(direction);
    const dropped = await dispatchDrag(window, target, 'drop', transfer, dropPoints[direction]);
    expect(dropped.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-drop]')).toBeNull();
    expect(document.querySelector('output')!.textContent).toBe('false');
    const panes = [...document.querySelectorAll('[data-workspace-pane]')].filter(pane => !pane.closest('[hidden]'));
    expect(panes.map(pane => pane.getAttribute('data-workspace-pane'))).toEqual(
      direction === 'left' || direction === 'up' ? ['editor', 'primary'] : ['primary', 'editor']);
    expect(panes[0]!.parentElement!.parentElement!.getAttribute('data-axis')).toBe(
      direction === 'left' || direction === 'right' ? 'columns' : 'rows');
    expect(document.querySelector('[aria-label="editor draft"]')).toBe(input);
    expect(document.querySelector('[aria-label="primary draft"]')).toBe(target);
    expect(input.value).toBe('preserved across reparenting');
  });
});

test('drag guides follow the pointer, ignore self and foreign drags, and clear on cancellation', async () => {
  await withDOM(async ({ render, window }) => {
    function Indicator() { return <output>{String(useSplitPreviewActive())}</output>; }
    await render(<><Fixture opened={[]} /><Indicator /></>);
    const source = document.querySelector('[aria-label="editor draft"]')!;
    const target = document.querySelector('[aria-label="primary draft"]')!;
    const handle = source.parentElement!.querySelector('[draggable]')!;
    const transfer = new window.DataTransfer();
    transfer.setData(workspacePaneDragType, 'editor');
    expect((await dispatchDrag(window, target, 'dragover', transfer, dropPoints.left)).defaultPrevented).toBe(false);
    await dispatchDrag(window, handle, 'dragstart', transfer);
    expect((await dispatchDrag(window, source, 'dragover', transfer, dropPoints.left)).defaultPrevented).toBe(false);
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      await dispatchDrag(window, target, 'dragover', transfer, dropPoints[direction]);
      expect(target.closest('[data-workspace-pane]')!.getAttribute('data-drop')).toBe(direction);
    }
    await dispatchDrag(window, target, 'dragover', transfer);
    expect(document.querySelector('[data-drop]')).toBeNull();
    await dispatchDrag(window, target, 'dragover', transfer, dropPoints.up);
    await dispatchDrag(window, handle, 'dragend', transfer);
    expect(document.querySelector('[data-drop]')).toBeNull();
    expect(document.querySelector('output')!.textContent).toBe('false');
    expect(source.closest('[data-workspace-pane]')!.parentElement!.parentElement!.getAttribute('data-axis')).toBe('columns');
  });
});

test('drop uses the final pointer position instead of the previous guide', async () => {
  await withDOM(async ({ render, window }) => {
    await render(<Fixture opened={[]} />);
    const source = document.querySelector('[aria-label="editor draft"]')!;
    const target = document.querySelector('[aria-label="primary draft"]')!;
    const transfer = new window.DataTransfer();
    await dispatchDrag(window, source.parentElement!.querySelector('[draggable]')!, 'dragstart', transfer);
    await dispatchDrag(window, target, 'dragover', transfer, dropPoints.left);
    await dispatchDrag(window, target, 'drop', transfer, dropPoints.down);
    const split = target.closest('[data-workspace-pane]')!.parentElement!.parentElement!;
    expect(split.getAttribute('data-axis')).toBe('rows');
    expect([...split.querySelectorAll('[data-workspace-pane]')].map(pane => pane.getAttribute('data-workspace-pane'))).toEqual(['primary', 'editor']);
  });
});

test('drop geometry rejects the center, outside bounds and zero size; root placement supports all four directions', () => {
  const bounds = { left: 0, top: 0, width: 1200, height: 800 };
  expect(workspaceDropDirection(bounds, 600, 400)).toBeNull();
  expect(workspaceDropDirection(bounds, -1, 400)).toBeNull();
  expect(workspaceDropDirection({ ...bounds, width: 0 }, 0, 0)).toBeNull();
  expect(workspaceDropDirection(bounds, NaN, 400)).toBeNull();
  for (const direction of ['left', 'right', 'up', 'down'] as const) {
    const [x, y] = dropPoints[direction];
    expect(workspaceDropDirection(bounds, x, y)).toBe(direction);
    const moved = placeWorkspacePane(visibleWorkspaceLayout('split', false), 'workspace', 'terminal', direction);
    expect(splitPaneIds(moved)).toEqual(direction === 'left' || direction === 'up'
      ? ['terminal', 'editor', 'primary'] : ['editor', 'primary', 'terminal']);
    expect(parseWorkspaceLayout(moved)).toEqual(moved);
  }
});

test('maximize is disabled for one pane and restore remains enabled while a split is maximized', async () => {
  await withDOM(async ({ render, click }) => {
    const area = (name: string) => <section data-content={name}><WorkspaceLayoutControls /></section>;
    const show = (mode: 'editor' | 'split') => render(<WorkspaceEditorSplit mode={mode}
      onLayoutChange={() => {}} editor={area('editor')}>{area('primary')}</WorkspaceEditorSplit>);
    const editorButton = () => document.querySelector<HTMLButtonElement>('[data-content="editor"] button[aria-label="Maximize pane"]')!;
    const visiblePanes = () => [...document.querySelectorAll('[data-workspace-pane]')].filter(pane => !pane.closest('[hidden]'));
    await show('editor');
    expect(editorButton().disabled).toBe(true);
    await act(async () => editorButton().click());
    expect(document.querySelector('[aria-label="Restore pane size"]')).toBeNull();
    expect(visiblePanes()).toHaveLength(1);

    await show('split');
    expect(editorButton().disabled).toBe(false);
    await act(async () => editorButton().click());
    const restore = document.querySelector<HTMLButtonElement>('[aria-label="Restore pane size"]')!;
    expect(restore.disabled).toBe(false);
    expect(visiblePanes()).toHaveLength(1);
    await click('Restore pane size');
    expect(visiblePanes()).toHaveLength(2);

    await act(async () => editorButton().click());
    await show('editor');
    expect(editorButton().disabled).toBe(true);
    expect(document.querySelector('[aria-label="Restore pane size"]')).toBeNull();
    await show('split');
    expect(visiblePanes()).toHaveLength(2);
    expect(editorButton().disabled).toBe(false);
  });
});
