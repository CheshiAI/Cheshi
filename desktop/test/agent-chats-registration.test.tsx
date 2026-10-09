import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import type { AgentRegistrySnapshot } from '../shared/agent-registry';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';

function fixture() {
  const agents = ['dev', 'peer'].map(id => ({ ...specialistAgent(), id, name: id, accountId: 'account',
    assignments: [{ workspaceRoot: '/project', instructions: '' }] }));
  const data: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/project', name: 'Saved room', engineId: 'docker:test',
    defaultAgentId: 'dev', members: agents.map(({ id, name, accountId }) => ({ id, name, accountId })), createdAt: '2026-10-09T00:00:00Z' }],
    messages: [{ id: 'old', roomId: 'room', threadId: null, sender: 'dev', recipient: null, kind: 'message', text: 'Saved reply', createdAt: '2026-10-09T00:00:00Z' }] };
  const requests: ChatsRequest[] = [];
  let changed: (snapshot: AgentRegistrySnapshot) => void = () => {};
  const registry = { list: async (): Promise<AgentRegistrySnapshot> => ({ workspaceRoot: '/project', agents: [...agents] }),
    onDidChange: (listener: (snapshot: AgentRegistrySnapshot) => void) => { changed = listener; return () => { changed = () => {}; }; } };
  const api = { request: async (request: ChatsRequest) => { requests.push(request); return data; } };
  return { agents, data, requests, registry, api, update: () => changed({ workspaceRoot: '/project', agents: [...agents] }) };
}
const sendButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;

test('registry deletion preserves the room, history and draft, blocks click and Enter, and permits a registered peer', async () => {
  await withDOM(async ui => {
    const f = fixture();
    await ui.render(<ChatsView active api={f.api} registry={f.registry} />);
    await ui.type('Message', 'Keep this draft'); expect(sendButton().disabled).toBe(false);
    await act(async () => { f.agents.splice(0, 1); f.update(); });
    expect(document.querySelector('[aria-label="Room participants"]')?.textContent).toContain('dev · Deleted Homie');
    expect(document.querySelector('[aria-label="Worker rooms"]')?.textContent).toContain('Deleted Homie · Conversation saved');
    expect(document.querySelector('[aria-label="Room messages"]')?.textContent).toContain('Saved reply');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep this draft');
    expect(sendButton().disabled).toBe(true);
    await ui.click('Send message');
    await act(async () => { document.querySelector('[aria-label="Message"]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(f.requests.some(request => request.action === 'send')).toBe(false);
    await ui.type('Message', '@dev do work'); expect(sendButton().disabled).toBe(true);
    await ui.type('Message', '@d'); expect(document.querySelector('[aria-label="Mention suggestions"]')).toBeNull();
    await ui.type('Message', '@peer do work'); expect(sendButton().disabled).toBe(false);
    await ui.click('Send message');
    expect(f.requests.filter(request => request.action === 'send')).toMatchObject([{ recipient: 'peer', text: '@peer do work' }]);
    await ui.click('Reply to Saved reply'); await ui.type('Message', 'Continue');
    expect(sendButton().disabled).toBe(true);
    expect(f.data.messages).toHaveLength(1); expect(f.data.rooms).toHaveLength(1);
  });
});

test.each(['unassigned', 'account-replaced'])('%s is unavailable but not falsely labelled deleted', async reason => {
  await withDOM(async ui => {
    const f = fixture();
    if (reason === 'unassigned') f.agents[0]!.assignments = [];
    else f.agents[0]!.accountId = 'replacement';
    await ui.render(<ChatsView active api={f.api} registry={f.registry} />);
    await ui.type('Message', 'Do work');
    expect(sendButton().disabled).toBe(true);
    expect(document.body.textContent).toContain('Homie unavailable');
    expect(document.body.textContent).not.toContain('Deleted Homie');
  });
});

test('pending, failed and stale catalog reads cannot enable delivery or falsely report deletion', async () => {
  await withDOM(async ui => {
    const f = fixture(), first = registryDeferred<AgentRegistrySnapshot>(), second = registryDeferred<AgentRegistrySnapshot>();
    let calls = 0;
    f.registry.list = () => ++calls === 1 ? first.promise : second.promise;
    await ui.render(<ChatsView active api={f.api} registry={f.registry} />);
    await ui.type('Message', 'Do work'); expect(sendButton().disabled).toBe(true);
    expect(document.body.textContent).not.toContain('Deleted Homie');
    await act(async () => { f.update(); second.reject(new Error('offline')); });
    expect(document.body.textContent).toContain('registration could not be checked');
    await act(async () => { first.resolve({ workspaceRoot: '/project', agents: f.agents }); });
    expect(sendButton().disabled).toBe(true);
    expect(document.body.textContent).not.toContain('Deleted Homie');
    f.registry.list = async () => ({ workspaceRoot: '/project', agents: f.agents });
    await act(async () => f.update());
    expect(sendButton().disabled).toBe(false);
  });
});
