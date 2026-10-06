import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import { withDOM } from './agent-chats-test-dom';
const snapshot = (): ChatsSnapshot => ({ rooms: [{ id: 'room', workspace: '/project', name: 'Permissions', engineId: 'docker:test', defaultAgentId: 'dev',
  members: [{ id: 'dev', accountId: 'account', name: 'Development' }], createdAt: '2026-10-06T00:00:00Z' }], messages: [
  { id: 'request', roomId: 'room', threadId: null, sender: 'dev', recipient: 'user', taskId: 'task', kind: 'permission_request', text: 'Run regression tests', createdAt: '2026-10-06T00:00:01Z',
    permissionRequest: { id: 'permission', reason: 'Run regression tests', fileWrite: false, commandExecution: true, status: 'pending' } },
] });
test('Chats shows scoped permissions and waits for acknowledgement; failure keeps the card and draft', async () => {
  await withDOM(async ui => {
    const data = snapshot(), calls: ChatsRequest[] = [];
    let reject!: (e: Error) => void;
    const api = { request: (input: ChatsRequest) => {
      calls.push(input);
      return input.action === 'permission' ? new Promise<ChatsSnapshot>((_resolve, no) => { reject = no; }) : Promise.resolve(data);
    } };
    await ui.render(<ChatsView active api={api} />);
    expect(document.body.textContent).toContain('Run commands');
    expect(document.body.textContent).toContain('Project: /project');
    await ui.type('Message', 'Keep this draft');
    await ui.click('Allow for project');
    expect(calls.at(-1)).toEqual({ action: 'permission', roomId: 'room', messageId: 'request', decision: 'allow' });
    expect(document.body.textContent).toContain('Applying…');
    await act(async () => reject(new Error('Worker is busy')));
    expect(document.body.textContent).toContain('Worker is busy');
    expect(document.body.textContent).toContain('Needs approval');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });
});
test('denial hides permission controls only after the stored reply arrives', async () => {
  await withDOM(async ui => {
    let data = snapshot();
    const api = { request: async (input: ChatsRequest) => {
      if (input.action === 'permission') data = { ...data, messages: data.messages.map(m => ({ ...m, permissionRequest: { ...m.permissionRequest!, status: 'denied' } })) };
      return data;
    } };
    await ui.render(<ChatsView active api={api} />); await ui.click('Deny');
    expect(document.body.textContent).toContain('Permission denied.');
    expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Allow for project')).toBe(false);
  });
});
