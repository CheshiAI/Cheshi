import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import type { ChatUserInputRequest } from '../shared/chat-user-input';
import { initialInputDraft, inputResponse, type InputDraft } from '../frontend/src/features/chat/chatUserInputForm';

test('MCP shared controls preserve typed answers, clearing, and busy portal behavior', async () => {
  const window = new Window();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const globals = {
    window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { ChatMcpFields } = await import('../frontend/src/features/chat/ChatUserInputFields');
  const request: Extract<ChatUserInputRequest, { kind: 'form' }> = {
    id: 'mcp', threadId: 'thread', turnId: null, kind: 'form', serverName: 'Example', message: 'Configure',
    fields: [
      { name: 'count', title: 'Count', description: '', type: 'integer', required: true, default: 0 },
      { name: 'enabled', title: 'Enabled', description: '', type: 'boolean', required: true, default: true },
      { name: 'mode', title: 'Mode', description: '', type: 'string', required: true,
        options: [{ value: 'read_only', label: 'Read only' }, { value: 'write', label: 'Write' }] },
      { name: 'tags', title: 'Tags', description: '', type: 'array', required: false,
        options: [{ value: 'alpha', label: 'Alpha' }] },
      { name: 'note', title: 'Note', description: '', type: 'string', required: false, default: 'Draft' },
    ],
  };
  let latest: InputDraft = {};
  let setDisabled!: (value: boolean) => void;
  function Fixture() {
    const [draft, setDraft] = useState(() => initialInputDraft(request));
    const [disabled, updateDisabled] = useState(false);
    latest = draft;
    setDisabled = updateDisabled;
    return <ChatMcpFields fields={request.fields} draft={draft} disabled={disabled}
      onChange={(name, value) => setDraft(current => ({ ...current, [name]: value }))} />;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const select = async (label: string, choice: string) => {
    await act(async () => { button(label).click(); });
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(item => item.textContent === choice);
    expect(option).toBeDefined();
    await act(async () => { option!.click(); });
  };
  try {
    await act(async () => { root.render(<Fixture />); });
    await select('Enabled', 'No');
    await select('Mode', 'Read only');
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      button('Clear Note').click();
    });
    expect(inputResponse(request, latest)).toEqual({
      action: 'accept', content: { count: 0, enabled: false, mode: 'read_only', tags: ['alpha'] },
    });
    expect(button('Clear Note')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('input[type="text"]'));
    await select('Mode', 'Choose an option');
    expect(() => inputResponse(request, latest)).toThrow('Enter Mode');
    await select('Mode', 'Write');
    await act(async () => { button('Mode').click(); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => { setDisabled(true); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect([...container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')]
      .every(control => control.disabled)).toBe(true);
    await act(async () => { button('Enabled').click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(latest.mode).toBe('write');
    expect(latest.enabled).toBe('false');
  } finally {
    await act(async () => { root.unmount(); });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
