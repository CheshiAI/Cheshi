import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window, type HTMLButtonElement as TestButton } from 'happy-dom';
import { INITIAL_CHAT_STATE, type ChatMcpServer } from '../frontend/src/features/chat/model';
import { slashCommands } from '../frontend/src/features/chat/chatViewModel';
import type { ChatController } from '../frontend/src/features/chat/useChatController';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Keep the real configuration/focus hook and replace only unrelated composer services.
function loadController() {
  const url = new URL('../frontend/src/features/chat/useChatViewController.ts', import.meta.url);
  const require = createRequire(url);
  const dependencies: Record<string, unknown> = {
    '../../cheshiDesktop': { cheshiDesktop: undefined },
    './useChatAttachmentTransfer': { useChatAttachmentTransfer: () => ({ loading: false }) },
    './useChatMessageQueue': { useChatMessageQueue: () => ({ entries: [] }) },
  };
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports, document, Node, Element, ResizeObserver,
    require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
  });
  return exports as typeof import('../frontend/src/features/chat/useChatViewController');
}

async function withMenu(run: (harness: {
  window: Window;
  open: () => Promise<void>;
  flushFrames: () => Promise<void>;
  finish: () => Promise<void>;
  changeDraft: (value: string) => Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const frames: FrameRequestCallback[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator, Node: window.Node,
    Element: window.Element, ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const response = createDeferred<ChatMcpServer[]>();
  const controller = {
    state: INITIAL_CHAT_STATE, sessionRevision: 0,
    listModels: async () => ({ models: [], configuration: null }),
    listMcpServers: () => response.promise,
  } as unknown as ChatController;
  const { useChatViewController } = loadController();
  let changeDraft: (value: string) => void;
  function Fixture() {
    const view = useChatViewController({ controller, onNewSession: () => {} });
    changeDraft = view.handleDraftChange;
    return <>
      <button id="other-pane">Other pane</button>
      <section ref={view.rootRef} onKeyDown={view.handleEscape}>
        {!view.commandMenuOpen && <button id="mcp" onClick={() => {
          void view.activateSlashCommand(slashCommands.find(command => command.name === 'mcp')!);
        }}>MCP</button>}
        {view.commandMenuOpen && <div id="menu">{view.commandLoading ? 'Loading' : 'Ready'}</div>}
        <textarea ref={element => { view.textareaRef.current = element; }} onKeyDown={view.handleKeyDown}
          value={view.draft} onChange={event => view.handleDraftChange(event.currentTarget.value)} />
      </section>
    </>;
  }
  try {
    await act(async () => root.render(<Fixture />));
    await run({
      window,
      open: async () => {
        await act(async () => {
          const option = container.querySelector<TestButton>('#mcp')!;
          option.focus();
          option.click();
        });
        expect(container.querySelector('#menu')?.textContent).toBe('Loading');
      },
      flushFrames: async () => { await act(async () => { for (const frame of frames.splice(0)) frame(0); }); },
      finish: async () => { await act(async () => response.resolve([])); },
      changeDraft: async value => { await act(async () => changeDraft(value)); },
    });
  } finally {
    response.resolve([]);
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('a delayed MCP response preserves composer focus and Escape closes the menu', async () => {
  await withMenu(async h => {
    await h.open();
    await h.flushFrames();
    expect(h.window.document.activeElement?.tagName).toBe('TEXTAREA');
    await h.finish();
    await h.flushFrames();
    expect(h.window.document.querySelector('#menu')?.textContent).toBe('Ready');
    await act(async () => {
      h.window.document.activeElement!.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(h.window.document.querySelector('#menu')).toBeNull();
  });
});

test('opening and completing MCP status never steals focus from another pane', async () => {
  await withMenu(async h => {
    await h.open();
    const other = h.window.document.querySelector<TestButton>('#other-pane')!;
    other.focus();
    await h.flushFrames();
    expect(h.window.document.activeElement === other).toBe(true);
    await h.finish();
    await h.flushFrames();
    expect(h.window.document.activeElement === other).toBe(true);
  });
});

test('pasted local paths preserve the draft without opening commands, while slash commands still open', async () => {
  await withMenu(async h => {
    for (const value of ['/Users/cheshi/Developments/cheshi-flash', '/tmp/example.txt',
      '/Users/cheshi/My Project', '//server/share', '[/tmp/example](</tmp/example>)']) {
      await h.changeDraft(value);
      expect(h.window.document.querySelector('#menu') === null).toBe(true);
      expect(h.window.document.querySelector('textarea')?.value).toBe(value);
    }
    for (const value of ['/', '/mo', '/model']) {
      await h.changeDraft(value);
      expect(h.window.document.querySelector('#menu') !== null).toBe(true);
    }
    await h.changeDraft('/model/config.json');
    expect(h.window.document.querySelector('#menu') === null).toBe(true);
    expect(h.window.document.querySelector('textarea')?.value).toBe('/model/config.json');
  });
});
