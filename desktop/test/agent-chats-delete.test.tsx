import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { DeleteRoomDialog } from '../frontend/src/features/agent-chats/DeleteRoomDialog';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import { withDOM } from './agent-chats-test-dom';

function snapshot(): ChatsSnapshot {
  return { rooms: ['room', 'other'].map(id => ({ id, name: id, workspace: '/fixture', engineId: 'docker:test', defaultAgentId: 'dev',
    members: [{ id: 'dev', accountId: 'account', name: 'Dev' }], createdAt: '2026-10-05T00:00:00Z' })), messages: [
    { id: 'note', roomId: 'room', sender: 'user', recipient: null, threadId: null, kind: 'message', text: 'Room note', createdAt: '2026-10-05T00:00:00Z' },
  ] };
}
test('room deletion cancels without requests, then removes selected room and preserves other drafts', async () => {
  await withDOM(async ui => {
    let data = snapshot(); const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => {
      requests.push(request);
      if (request.action === 'delete') data = { rooms: data.rooms.filter(room => room.id !== request.roomId), messages: data.messages.filter(message => message.roomId !== request.roomId) };
      return data;
    } };
    await ui.render(<ChatsView active api={api} />);
    await ui.type('Message', 'discard draft'); await ui.click('Reply to Room note');
    await ui.click('other'); await ui.type('Message', 'keep draft'); await ui.click('room');
    await ui.click('Delete room: room');
    expect(document.querySelector('dialog')?.textContent).toContain('This cannot be undone.');
    await ui.click('Cancel'); expect(requests.filter(request => request.action === 'delete')).toHaveLength(0);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('discard draft');
    expect(document.body.textContent).toContain('Room note');
    await ui.click('Delete room: room'); await ui.click('Delete room');
    expect(requests.filter(request => request.action === 'delete')).toEqual([{ action: 'delete', roomId: 'room' }]);
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('button[aria-current="page"]')?.getAttribute('aria-label')).toBe('other');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('keep draft');
    // Reintroduce the fixture identity to prove local draft/reply state was removed.
    data = snapshot(); await ui.click('Refresh rooms'); await ui.click('room');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('');
    expect(document.querySelector('[aria-label="Cancel reply"]')).toBeNull();
  });
});
test('failed deletion retains the room, draft and confirmation and supports cancel', async () => {
  await withDOM(async ui => {
    const api = { request: async (request: ChatsRequest) => {
      if (request.action === 'delete') throw new Error('Journal save failed');
      return snapshot();
    } };
    await ui.render(<ChatsView active api={api} />); await ui.type('Message', 'keep failed draft');
    await ui.click('Delete room: room'); await ui.click('Delete room');
    expect(document.querySelector('dialog')?.textContent).toContain('Journal save failed');
    await ui.click('Cancel');
    expect(document.querySelector('button[aria-current="page"]')?.getAttribute('aria-label')).toBe('room');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('keep failed draft');
  });
});
test.each(['running', 'queued', 'unknown'])('confirmation blocks %s work', async status => {
  await withDOM(async ui => {
    const data = snapshot(); data.messages[0] = { ...data.messages[0]!, taskId: 'task', recipient: 'dev', status };
    let deletions = 0;
    const api = { request: async (request: ChatsRequest) => { if (request.action === 'delete') deletions++; return data; } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Delete room: room'); await ui.click('Delete room');
    expect(document.querySelector('dialog')?.textContent).toContain('pending or unresolved'); expect(deletions).toBe(0);
    await ui.click('Cancel');
  });
});
test('pending confirmation guards double submit and all dismissals until acknowledgement', async () => {
  await withDOM(async ui => {
    let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
    let calls = 0, closed = 0;
    await ui.render(<DeleteRoomDialog name="fixture" blocked={false} onDelete={async () => { calls++; await promise; }} onClose={() => { closed++; }} />);
    await ui.click('Delete room'); await ui.click('Deleting…'); await ui.click('Cancel'); await ui.click('Close dialog');
    expect(calls).toBe(1); expect(closed).toBe(0);
    await act(async () => { resolve(); }); expect(closed).toBe(1);
  });
});
