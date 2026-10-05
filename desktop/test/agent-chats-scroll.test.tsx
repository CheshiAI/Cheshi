import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { AgentChatsApi, ChatsSnapshot, ChatsUpdate, RoomMessage } from '../shared/agent-chats';

const message = (id: string, roomId = 'a'): RoomMessage => ({ id, roomId, threadId: null,
  sender: 'user', recipient: null, kind: 'message', text: id, createdAt: '2026-10-05T00:00:00Z' });

async function withChats(run: (ui: {
  update(messages: RoomMessage[]): Promise<void>;
  scroll(top: number): Promise<void>;
  click(label: string): Promise<void>;
  resize(): Promise<void>;
  timeline(): HTMLDivElement;
  geometry: { height: number; growth: number };
}) => Promise<void>) {
  const window = new Window();
  const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
  class Observer implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { observers.set(this, { callback, targets: new Set() }); }
    observe(target: Element) { observers.get(this)!.targets.add(target); }
    unobserve(target: Element) { observers.get(this)!.targets.delete(target); }
    disconnect() { observers.delete(this); }
  }
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, HTMLDialogElement: window.HTMLDialogElement,
    ResizeObserver: Observer, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const geometry = { height: 1500, growth: 0 };
  const scrollTops = new WeakMap<object, number>(), pendingScrolls = new Set<HTMLElement>();
  const prototype = window.HTMLElement.prototype;
  const previousProperties = new Map(['scrollHeight', 'clientHeight', 'scrollTop', 'getBoundingClientRect']
    .map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: { configurable: true, get() { return this.getAttribute('aria-label') === 'Room messages' ? geometry.height : 0; } },
    clientHeight: { configurable: true, get() { return this.getAttribute('aria-label') === 'Room messages' ? 500 : 0; } },
    scrollTop: { configurable: true,
      get() { return scrollTops.get(this) ?? 0; },
      set(value: number) {
        const top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
        if (top === (scrollTops.get(this) ?? 0)) return;
        scrollTops.set(this, top); pendingScrolls.add(this as HTMLElement);
      },
    },
  });
  // Browsers clamp scrollTop and deliver programmatic scroll events after layout.
  const perform = async (operation: () => void) => {
    await act(async () => operation());
    while (pendingScrolls.size) {
      const nodes = [...pendingScrolls]; pendingScrolls.clear();
      await act(async () => { for (const node of nodes) if (node.isConnected)
        node.dispatchEvent(new window.Event('scroll', { bubbles: true }) as unknown as Event); });
    }
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const node = this as unknown as HTMLElement;
    const index = node.dataset.messageId ? [...node.parentElement!.children].indexOf(node) : -1;
    const top = index < 0 ? 0 : index * 100 + (index > 0 ? geometry.growth : 0) - node.closest('[aria-label="Room messages"]')!.scrollTop;
    const height = index < 0 ? 0 : 100 + (index === 0 ? geometry.growth : 0);
    return new window.DOMRect(0, top, 640, height);
  };
  let sequence = 0, receive: ((update: ChatsUpdate) => void) | undefined;
  const snapshot: ChatsSnapshot = { cursor: { epoch: 'test', sequence },
    rooms: ['a', 'b'].map(id => ({ id, name: id === 'a' ? 'Alpha' : 'Beta', workspace: '/project', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [], createdAt: '2026-10-05T00:00:00Z' })),
    messages: [message('a1'), message('a2'), message('a3'), message('b1', 'b')] };
  const api: AgentChatsApi = { request: async () => snapshot, onDidChange: listener => { receive = listener; return () => { receive = undefined; }; } };
  const container = document.createElement('div'); document.body.append(container);
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container);
  const timeline = () => document.querySelector<HTMLDivElement>('[aria-label="Room messages"]')!;
  try {
    await perform(() => root.render(<ChatsView active api={api} />));
    await run({ geometry, timeline,
      update: async messages => { await perform(() => receive!({ cursor: { epoch: 'test', sequence: ++sequence }, messages,
        rooms: [], removedRoomIds: [], removedMessageIds: [] })); },
      scroll: async top => { await perform(() => { timeline().scrollTop = top; }); },
      click: async label => { const button = [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label);
        if (!button) throw new Error(`Missing button ${label}`); await perform(() => button.click()); },
      resize: async () => { await perform(() => { const content = timeline().firstElementChild;
        for (const [observer, entry] of observers) if (content && entry.targets.has(content)) entry.callback([], observer); }); },
    });
  } finally {
    try { await act(async () => root.unmount()); await window.happyDOM.close(); }
    finally {
      for (const [key, descriptor] of previousProperties) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else Reflect.deleteProperty(prototype, key);
      }
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  }
}

const jump = () => document.querySelector<HTMLButtonElement>('[aria-label="Jump to latest messages"]');

test('Chats counts distinct arrivals while reading, restores each room and clears on jump or bottom scroll', async () => {
  await withChats(async ui => {
    expect(jump()).toBeNull();
    expect(ui.timeline().scrollTop).toBe(1000);
    await ui.scroll(100);
    await ui.update([message('a4')]);
    expect(ui.timeline().scrollTop).toBe(100);
    expect(jump()?.textContent).toBe('1 new message');
    expect(jump()?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const first = message('a4'); first.text = 'streaming'; first.status = 'sending';
    await ui.update([first]); await ui.update([first]);
    expect(jump()?.textContent).toBe('1 new message');
    await ui.click('Beta');
    expect(jump()).toBeNull();
    await ui.scroll(200); await ui.update([message('b2', 'b'), message('a5')]);
    expect(jump()?.textContent).toBe('1 new message');
    await ui.click('Alpha');
    expect(ui.timeline().scrollTop).toBe(100);
    expect(jump()?.textContent).toBe('2 new messages');
    await ui.click('Jump to latest messages');
    expect(ui.timeline().scrollTop).toBe(1000); expect(jump()).toBeNull();
    ui.geometry.height = 1800; await ui.update([message('a6')]);
    expect(ui.timeline().scrollTop).toBe(1300); expect(jump()).toBeNull();
    await ui.click('Beta');
    expect(ui.timeline().scrollTop).toBe(200); expect(jump()?.textContent).toBe('1 new message');
    await ui.scroll(1300); expect(jump()).toBeNull();
    ui.geometry.height = 2000; await ui.update([message('b3', 'b')]);
    expect(ui.timeline().scrollTop).toBe(1500); expect(jump()).toBeNull();
  });
});

test('Chats keeps the visible message anchored across text growth above it and asynchronous resizing', async () => {
  await withChats(async ui => {
    await ui.scroll(100);
    ui.geometry.growth = 80; ui.geometry.height += 80;
    await ui.update([{ ...message('a1'), text: 'A much longer streamed message' }]);
    expect(ui.timeline().scrollTop).toBe(180); expect(jump()?.textContent).toBe('');
    ui.geometry.growth = 160; ui.geometry.height += 80;
    await ui.resize(); expect(ui.timeline().scrollTop).toBe(260);
    await ui.update([message('a4')]);
    expect(ui.timeline().scrollTop).toBe(260); expect(jump()?.textContent).toBe('1 new message');
  });
});


test('jump button appears without new arrivals and clears after clicking or reaching the bottom', async () => {
  await withChats(async ui => {
    await ui.scroll(100);
    expect(jump()?.textContent).toBe('');
    expect(jump()?.getAttribute('data-size')).toBe('icon');
    await ui.click('Beta'); expect(jump()).toBeNull();
    await ui.click('Alpha'); expect(jump()).not.toBeNull();
    await ui.click('Jump to latest messages');
    expect(ui.timeline().scrollTop).toBe(1000); expect(jump()).toBeNull();
    await ui.scroll(100); expect(jump()).not.toBeNull();
    await ui.scroll(1000); expect(jump()).toBeNull();
  });
});
