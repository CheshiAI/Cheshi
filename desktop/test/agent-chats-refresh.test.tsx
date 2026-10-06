import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import { withDOM } from './agent-chats-test-dom';

function snapshot(): ChatsSnapshot {
  return { rooms: ['Alpha', 'Beta'].map(name => ({
    id: name, name, workspace: '/project', engineId: 'docker:test', defaultAgentId: 'dev',
    members: [{ id: 'dev', accountId: 'account', name: 'Development' }], createdAt: '2026-10-03T00:00:00Z',
  })), messages: [] };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const viewport = () => document.querySelector<HTMLElement>('[role="region"][aria-label="Rooms"]')!;
const refreshButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Refresh rooms"]')!;
const status = () => document.querySelector('[aria-label="Worker rooms"] [role="status"]');
const selectedRoom = () => document.querySelector('[aria-label="Worker rooms"] [aria-current="page"]');

async function pointer(type: string, y: number) {
  await act(async () => {
    const event = new window.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
      clientY: y, clientX: 10, button: 0, bubbles: true, cancelable: true });
    if (type === 'pointerdown') viewport().dispatchEvent(event);
    else window.dispatchEvent(event);
  });
}

async function wheel(deltaY: number) {
  await act(async () => {
    viewport().dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  });
}

async function wheelIdle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
}

for (const gesture of ['pointer', 'wheel'] as const) {
  test(`Worker ${gesture} refresh awaits the request, prevents duplicates, and preserves search, selection and draft`, async () => {
    await withDOM(async ui => {
      const gate = createDeferred<ChatsSnapshot>();
      let pending = false;
      const requests: ChatsRequest[] = [];
      const api = { request: async (request: ChatsRequest) => {
        requests.push(request);
        return pending ? gate.promise : snapshot();
      } };
      await ui.render(<ChatsView active api={api} />);
      await ui.click('Beta');
      await ui.type('Search rooms', 'Beta');
      await ui.type('Message', 'Keep this draft');
      const before = requests.length;
      pending = true;

      if (gesture === 'pointer') {
        await pointer('pointerdown', 10);
        await pointer('pointermove', 110);
      } else {
        await wheel(-40);
        await wheel(-50);
      }
      expect(requests).toHaveLength(before);
      expect(status()?.textContent).toBe('Release to refresh');
      if (gesture === 'pointer') await pointer('pointerup', 110);
      else await wheelIdle();

      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)).toEqual({ action: 'list' });
      expect(refreshButton().disabled).toBe(true);
      expect(status()?.textContent).toBe('Release to refresh');
      await ui.click('Refresh rooms');
      await pointer('pointerdown', 10);
      await pointer('pointermove', 110);
      await pointer('pointerup', 110);
      await wheel(-100);
      await wheelIdle();
      expect(requests).toHaveLength(before + 1);

      const updated = snapshot();
      updated.rooms.push({ ...updated.rooms[0]!, id: 'new', name: 'Beta new' });
      await act(async () => gate.resolve(updated));
      expect(refreshButton().disabled).toBe(false);
      expect(status()).toBeNull();
      expect(document.querySelector('button[aria-label="Beta new"]')).not.toBeNull();
      expect(document.querySelector('button[aria-label="Alpha"]')).toBeNull();
      expect(selectedRoom()?.getAttribute('aria-label')).toBe('Beta');
      expect(document.querySelector<HTMLInputElement>('[aria-label="Search rooms"]')?.value).toBe('Beta');
      expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep this draft');
    });
  });
}

test('Worker ordinary scrolling to the top and short pulls do not refresh', async () => {
  await withDOM(async ui => {
    let calls = 0;
    await ui.render(<ChatsView active api={{ request: async () => { calls++; return snapshot(); } }} />);
    const before = calls;
    viewport().scrollTop = 30;
    await wheel(-60);
    viewport().scrollTop = 0;
    await wheel(-100);
    await wheelIdle();
    await pointer('pointerdown', 10);
    await pointer('pointermove', 30);
    await pointer('pointerup', 30);
    expect(calls).toBe(before);
    expect(status()).toBeNull();
    await wheel(-100);
    await wheelIdle();
    expect(calls).toBe(before + 1);
  });
});

test('Worker blocks refresh during initial loading and permits retry after a refresh failure', async () => {
  await withDOM(async ui => {
    let gate = createDeferred<ChatsSnapshot>();
    let calls = 0;
    await ui.render(<ChatsView active api={{ request: async () => { calls++; return gate.promise; } }} />);
    const before = calls;
    expect(refreshButton().disabled).toBe(true);
    await pointer('pointerdown', 10);
    await pointer('pointermove', 110);
    await pointer('pointerup', 110);
    await ui.click('Refresh rooms');
    expect(calls).toBe(before);
    await act(async () => gate.resolve(snapshot()));

    gate = createDeferred<ChatsSnapshot>();
    await ui.click('Refresh rooms');
    expect(refreshButton().disabled).toBe(true);
    await act(async () => gate.reject(new Error('Room refresh failed')));
    expect(refreshButton().disabled).toBe(false);
    expect(status()).toBeNull();
    expect(document.querySelector('[aria-label="Worker rooms"] [role="alert"]')?.textContent).toBe('Room refresh failed');
    expect(selectedRoom()).not.toBeNull();

    gate = createDeferred<ChatsSnapshot>();
    await ui.click('Refresh rooms');
    await act(async () => gate.resolve(snapshot()));
    expect(calls).toBe(before + 2);
    expect(document.querySelector('[aria-label="Worker rooms"] [role="alert"]')).toBeNull();
  });
});
