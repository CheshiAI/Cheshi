import { expect, test } from 'bun:test';
import type { IpcMainInvokeEvent } from 'electron';
import { createStickyNotesMenuAction, registerStickyNotesLibrary } from '../lib/sticky-notes-library.mts';
import { STICKY_NOTES_LIBRARY_CHANNEL as channel } from '../shared/sticky-notes.ts';

type Options = Parameters<typeof registerStickyNotesLibrary>[0];
function windowFixture() {
  const calls: string[] = [];
  const frame = {};
  const window = { isDestroyed: () => false, isMinimized: () => true,
    restore: () => { calls.push('restore'); }, show: () => { calls.push('show'); }, focus: () => { calls.push('focus'); },
    webContents: { isDestroyed: () => false, isLoadingMainFrame: () => false, mainFrame: frame,
      send: (name: string) => { calls.push(name); } },
  } as unknown as ReturnType<Options['windows']>[number];
  return { window, calls };
}

test('library accepts only workspace main frames and validates all deletion targets before calling the service', async () => {
  const { window, calls } = windowFixture();
  let invoke!: (event: IpcMainInvokeEvent, action: unknown, value?: unknown) => unknown;
  let changed = () => {};
  let unsubscribed = false, removed = '';
  const deletes: string[][] = [];
  const dispose = registerStickyNotesLibrary({
    ipc: { handle: (_name, handler) => { invoke = handler; }, removeHandler: name => { removed = name; } },
    windows: () => [window], service: {
      list: async () => [], rename: async () => {}, create: async () => {}, open: async () => {},
      deleteSelected: async ids => { deletes.push(ids); return { deletedIds: ids, failedIds: [] }; },
      onChanged: listener => { changed = listener; return () => { unsubscribed = true; }; },
    },
  });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent;
  expect(await invoke(event, 'list')).toEqual([]);
  const id = '12345678-1234-4123-8123-123456789abc';
  expect(() => invoke(event, 'delete-selected', [id, '../invalid'])).toThrow('Invalid note ID');
  expect(deletes).toEqual([]);
  expect(await invoke(event, 'delete-selected', [id, id])).toEqual({ deletedIds: [id], failedIds: [] });
  expect(deletes).toEqual([[id]]);
  expect(() => invoke({ ...event, senderFrame: {} } as IpcMainInvokeEvent, 'list')).toThrow('workspace window');
  expect(() => invoke({ ...event, sender: {} } as IpcMainInvokeEvent, 'list')).toThrow('workspace window');
  expect(() => invoke(event, 'save', {})).toThrow('Unsupported');
  expect(() => invoke(event, 'list', 42)).toThrow('search');
  expect(() => invoke(event, 'rename', { id, title: ' ' })).toThrow('title');
  expect(() => invoke(event, 'rename', { id: '../bad', title: 'Title' })).toThrow('ID');
  expect(await invoke(event, 'rename', { id, title: 'Title' })).toBeUndefined();
  changed(); expect(calls).toEqual([`${channel}:changed`]);
  dispose(); expect(unsubscribed).toBe(true); expect(removed).toBe(channel);
});

test('All Notes restores the focused workspace and coalesces workspace reopening', async () => {
  const first = windowFixture(), second = windowFixture();
  let windows: ReturnType<Options['windows']> = [first.window, second.window];
  let opened = 0;
  const action = createStickyNotesMenuAction({ windows: () => windows, focused: () => second.window,
    openWorkspace: async () => { opened++; windows = [first.window]; },
  });
  await action();
  expect(first.calls).toEqual([]);
  expect(second.calls).toEqual(['restore', 'show', 'focus', `${channel}:open-list`]);
  windows = [];
  await Promise.all([action(), action()]);
  expect(opened).toBe(1);
  expect(first.calls).toEqual(['restore', 'show', 'focus', `${channel}:open-list`]);
});
