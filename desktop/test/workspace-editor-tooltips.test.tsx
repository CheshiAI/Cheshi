import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';
import { acceptCompletion, autocompletion, moveCompletionSelection, startCompletion } from '@codemirror/autocomplete';
import { workspaceEditorTooltips } from '../frontend/src/features/editor/workspaceEditorTooltips';
import { workspaceEditorTheme } from '../frontend/src/features/editor/workspaceEditorTheme';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50));

async function withEditors(run: (create: (extensions: Extension) => EditorView) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    MutationObserver: window.MutationObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const views: EditorView[] = [];
  try {
    await run(extensions => {
      const host = document.createElement('div');
      document.body.append(host);
      const view = new EditorView({ parent: host, state: EditorState.create({
        extensions: [workspaceEditorTheme, workspaceEditorTooltips(document), extensions],
      }) });
      views.push(view);
      return view;
    });
  } finally {
    for (const view of views) view.destroy();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('editor tooltips use independent body portals and clean up when dismissed or destroyed', async () => {
  await withEditors(async create => {
    const popup = (label: string) => showTooltip.of({ pos: 0, arrow: true, create() {
      const dom = document.createElement('div');
      const content = document.createElement('span');
      content.textContent = label;
      dom.append(content);
      return { dom };
    } });
    const compartment = new Compartment();
    const first = create(compartment.of(popup('First editor')));
    const second = create(popup('Second editor'));
    await settle();
    const portals = document.querySelectorAll('.workspace-editor-tooltip-portal');
    expect(portals).toHaveLength(2);
    for (const portal of portals) {
      expect(portal.parentElement).toBe(document.body);
      const tooltip = portal.querySelector('.cm-tooltip')!;
      expect(tooltip.querySelectorAll(':scope > .workspace-editor-tooltip-surface')).toHaveLength(1);
      expect(tooltip.querySelector('.workspace-editor-tooltip-surface')?.getAttribute('aria-hidden')).toBe('true');
      expect(tooltip.querySelector('.cm-tooltip-arrow')).not.toBeNull();
    }
    expect(first.dom.querySelector('.cm-tooltip')).toBeNull();
    first.dispatch({ effects: compartment.reconfigure([]) });
    await settle();
    expect(portals[0]!.querySelector('.cm-tooltip')).toBeNull();
    expect(portals[1]!.textContent).toContain('Second editor');
    second.destroy();
    expect(portals[1]!.isConnected).toBe(false);
    first.dispatch({ effects: compartment.reconfigure(popup('Reopened')) });
    await settle();
    expect(portals[0]!.querySelectorAll('.workspace-editor-tooltip-surface')).toHaveLength(1);
    first.destroy();
    expect(document.querySelector('.workspace-editor-tooltip-portal')).toBeNull();
  });
});

test('completion navigation, documentation and insertion survive the layered tooltip surface', async () => {
  await withEditors(async create => {
    const view = create(autocompletion({ activateOnTyping: false, closeOnBlur: false, interactionDelay: 0,
      override: [() => ({ from: 0, options: [
        { label: 'alpha', info: 'Alpha documentation' },
        { label: 'beta', info: 'Beta documentation' },
      ] })],
    }));
    view.focus();
    expect(startCompletion(view)).toBe(true);
    await settle();
    const menu = document.querySelector('.cm-tooltip-autocomplete')!;
    expect(menu).not.toBeNull();
    expect(menu.querySelector(':scope > ul[role="listbox"]')).not.toBeNull();
    expect(menu.querySelector('.cm-completionInfo')?.textContent).toContain('Alpha documentation');
    expect(moveCompletionSelection(true)(view)).toBe(true);
    await settle();
    expect(menu.querySelector('[aria-selected="true"]')?.textContent).toContain('beta');
    const info = menu.querySelector('.cm-completionInfo')!;
    expect(info.textContent).toContain('Beta documentation');
    expect(info.querySelectorAll(':scope > .workspace-editor-tooltip-surface')).toHaveLength(1);
    expect(acceptCompletion(view)).toBe(true);
    await settle();
    expect(view.state.doc.toString()).toBe('beta');
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull();
  });
});
