import { expect, test } from 'bun:test';
import { act } from 'react';
import { WorkspaceHostShell } from '../frontend/src/features/shell/WorkspaceHostShell';
import type { WorkspaceHostApi, WorkspaceHostEntry, WorkspaceHostState, WorkspaceRailEvent, WorkspaceRailOverlay } from '../shared/workspace-host';
import { withDOM } from './agent-chats-test-dom';

function entry(id: number, name: string): WorkspaceHostEntry {
  return { id, name, root: `/test/${name}`, view: 'explorer', sidebarOpen: true, running: 0, attention: false };
}

function createHost() {
  let state: WorkspaceHostState = { activeId: 1, entries: [entry(1, 'Desktop')] };
  let listener: ((state: WorkspaceHostState) => void) | undefined;
  const closed: number[] = [];
  const commands: string[] = [];
  const overlays: (WorkspaceRailOverlay | null)[] = [];
  let railListener: ((event: WorkspaceRailEvent) => void) | undefined;
  const publish = (next: WorkspaceHostState) => { state = next; listener?.(next); };
  const api: WorkspaceHostApi = {
    state: async () => state,
    onState: next => { listener = next; return () => { listener = undefined; }; },
    activate: async id => { publish({ ...state, activeId: id }); },
    close: async id => {
      closed.push(id);
      const entries = state.entries.filter(item => item.id !== id);
      publish({ entries, activeId: entries[0]?.id ?? null });
    },
    command: async command => { commands.push(command.action); },
    layout: async () => {},
    railOverlay: value => { overlays.push(value); },
    onRailEvent: next => { railListener = next; return () => { railListener = undefined; }; },
  };
  return { api, closed, commands, publish, overlays, railEvent: (event: WorkspaceRailEvent) => railListener?.(event) };
}

test('rail hover publishes a label and native label clicks invoke the original button', async () => {
  await withDOM(async ui => {
    const host = createHost();
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Github"]')!;
    await act(async () => { button.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })); });
    expect(button.hasAttribute('data-rail-expanded')).toBe(true);
    expect(host.overlays.at(-1)?.label).toBe('Github');
    await act(async () => host.railEvent({ id: button.dataset.railButton!, action: 'activate' }));
    expect(host.commands).toEqual(['navigate']);
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    expect(host.overlays.at(-1)).toBeNull();
    await act(async () => {
      button.blur(); button.focus();
    });
    expect(button.hasAttribute('data-rail-expanded')).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[role="tab"]')!.focus());
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    expect(host.overlays.at(-1)).toBeNull();
  });
});

test('adding and closing workspaces toggles close controls while preserving the remaining tab', async () => {
  await withDOM(async ui => {
    const host = createHost();
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const tablist = document.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute('data-single')).toBe('true');
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(tablist.querySelector('[aria-label^="Close workspace"]')).toBeNull();
    await ui.click('Open workspace');
    expect(host.commands).toEqual(['manager']);
    const originalTab = tablist.querySelector('[role="tab"]');
    await act(async () => host.publish({ activeId: 2, entries: [entry(1, 'Desktop'), entry(2, 'Flash')] }));
    expect(tablist.getAttribute('data-single')).toBe('false');
    expect(tablist.querySelectorAll('[aria-label^="Close workspace"]')).toHaveLength(2);
    expect(tablist.querySelector('[role="tab"]')).toBe(originalTab);
    await ui.click('Close workspace Flash');
    expect(host.closed).toEqual([2]);
    expect(tablist.getAttribute('data-single')).toBe('true');
    expect(tablist.querySelector('[aria-label^="Close workspace"]')).toBeNull();
    expect(tablist.querySelector('[role="tab"]')).toBe(originalTab);
    expect(originalTab?.getAttribute('aria-selected')).toBe('true');
  });
});

test('multiple tabs retain click and arrow-key selection and keyboard focus', async () => {
  await withDOM(async ui => {
    const host = createHost();
    host.publish({ activeId: 1, entries: [entry(1, 'Desktop'), entry(2, 'Flash'), entry(3, 'Show')] });
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const flash = document.querySelector<HTMLButtonElement>('[role="tab"][data-workspace-id="2"]')!;
    await act(async () => flash.click());
    const selected = () => document.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected()?.getAttribute('data-workspace-id')).toBe('2');
    await act(async () => {
      selected()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(selected()?.getAttribute('data-workspace-id')).toBe('3');
    expect(document.activeElement).toBe(selected());
    expect(document.querySelectorAll('[aria-label^="Close workspace"]')).toHaveLength(3);
  });
});
