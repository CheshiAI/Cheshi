import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsRoomList } from '../frontend/src/features/agent-chats/ChatsRoomList';
import { StickyNotesList } from '../frontend/src/features/sticky-notes/StickyNotesList';
import type { AgentRoom } from '../shared/agent-chats';
import type { StickyNotesLibraryApi, StickyNoteSummary } from '../shared/sticky-notes';
import { withDOM } from './agent-chats-test-dom';

test('Memo hides empty search and keeps unmatched queries editable', async () => {
  await withDOM(async ui => {
    let finishLoading!: (notes: StickyNoteSummary[]) => void;
    const pending = new Promise<StickyNoteSummary[]>(resolve => { finishLoading = resolve; });
    let loading = true;
    let notes: StickyNoteSummary[] = [];
    let changed = () => {};
    const api: StickyNotesLibraryApi = {
      list: async query => loading ? pending : query?.trim() ? [] : notes,
      create: async () => {}, open: async () => {}, rename: async () => {},
      deleteSelected: async ids => ({ deletedIds: ids, failedIds: [] }),
      onChanged: listener => { changed = listener; return () => {}; },
    };
    await ui.render(<StickyNotesList api={api} locked={false} onNew={() => {}} onOpen={() => {}} />);
    expect(document.querySelector('[role="search"]')).toBeNull();
    await act(async () => { loading = false; finishLoading([]); });
    expect(document.querySelector('[role="search"]')).toBeNull();
    notes = [{ id: 'note', title: 'Memo', preview: '', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }];
    await act(async () => changed());
    expect(document.querySelector('[aria-label="Search notes"]')).not.toBeNull();
    await ui.type('Search notes', 'missing');
    expect(document.querySelector('[data-note-id]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Search notes"]')?.value).toBe('missing');
    await ui.click('Clear note search');
    expect(document.querySelector('[data-note-id="note"]')).not.toBeNull();
    notes = [];
    await act(async () => changed());
    expect(document.querySelector('[role="search"]')).toBeNull();
  });
});

test('Worker hides empty search and keeps a query clearable when rooms disappear', async () => {
  await withDOM(async ui => {
    const room: AgentRoom = {
      id: 'room', workspace: '/project', name: 'Working room', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [{ id: 'dev', name: 'Development', accountId: 'account' }],
      createdAt: '2026-10-03T00:00:00Z',
    };
    const render = (rooms: AgentRoom[], loaded = true) => ui.render(
      <ChatsRoomList snapshot={{ rooms, messages: [] }} agents={[]} selectedId={null}
        phase={loaded ? 'ready' : 'loading'} loaded={loaded} refreshing={false} disabled={false}
        error={null} pinningRoomId={null} onPin={() => {}} onSelect={() => {}} onNew={() => {}}
        onRefresh={async () => {}} />,
    );
    await render([], false);
    expect(document.querySelector('[role="search"]')).toBeNull();
    await render([]);
    expect(document.querySelector('[role="search"]')).toBeNull();
    await render([room]);
    expect(document.querySelector('[aria-label="Search rooms"]')).not.toBeNull();
    await ui.type('Search rooms', 'missing');
    expect(document.querySelector(`[aria-label="${room.name}"]`)).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Search rooms"]')?.value).toBe('missing');
    await ui.click('Clear room search');
    expect(document.querySelector(`[aria-label="${room.name}"]`)).not.toBeNull();
    await ui.type('Search rooms', 'missing');
    await render([]);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Search rooms"]')?.value).toBe('missing');
    await ui.click('Clear room search');
    expect(document.querySelector('[role="search"]')).toBeNull();
  });
});
