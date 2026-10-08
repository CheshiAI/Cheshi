import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test } from 'bun:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { registerFlashMemoryIpc } from '../lib/flash/ipc.mts';
import { createFlashMemoryApi } from '../lib/flash-preload.cts';
import { FLASH_MEMORY_CHANNEL, type FlashMemoryStatus } from '../shared/flash-memory.ts';
import { observeFlashMemory, flashStatusPresentation } from '../frontend/src/features/chat/flashMemoryStatus.ts';
import { account, deferred, fixtureSummary, flashFixture, history, readRequest, rejection, session } from './flash-test-helpers.ts';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const ready: FlashMemoryStatus = { state: 'ready', processed: 1, total: 1, waiting: 0, error: null };

test('ready searches and reads do not synchronize while a new reply is being written', async () => {
  const f = await flashFixture();
  const raw = history();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session()] }), read: async () => raw } });
  memory.accounts(account());
  try {
    await memory.synchronize();
    const initialSyncs = f.methods.filter(method => method === 'sync.complete').length;
    raw.thread.turns.push({ id: 'new-turn', status: 'inProgress', items: [
      { id: 'new-message', type: 'agentMessage', text: 'Partial answer' },
    ] });
    for (const type of ['session-created', 'sessions-changed', 'text-delta', 'activity']) {
      memory.changed({ type, threadId: 's', turnId: 'new-turn' });
      expect(memory.status()).toEqual(ready);
    }
    f.searchHook(async () => { expect(memory.status()).toEqual(ready); });
    for (let i = 0; i < 2; i++) {
      await memory.execute('memory_search', { query: 'memory' }, 's', new AbortController().signal, 'new-turn');
      expect(await memory.execute('memory_read', readRequest(), 's', new AbortController().signal))
        .toMatchObject({ summary: 'A saved decision about local memory.' });
    }
    await pause(1100); // Beyond the background-sync debounce: ignored events must not queue work.
    expect(memory.status()).toEqual(ready);
    expect(f.methods.filter(method => method === 'sync.complete')).toHaveLength(initialSyncs);
    expect(f.methods.filter(method => method === 'sources.list')).toHaveLength(1);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(1);
  } finally { await memory.dispose(); await f.close(); }
});

test('turn completion schedules one sync of the final text despite the following catalog notification', async () => {
  const f = await flashFixture();
  const raw = history();
  const entered = deferred<void>(); const resume = deferred<void>();
  let block = false;
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => {
      if (block) { entered.resolve(); await resume.promise; }
      return { sessions: [session()] };
    }, read: async () => raw } });
  memory.accounts(account());
  try {
    await memory.synchronize();
    raw.thread.turns.push({ id: 'new-turn', status: 'completed', items: [
      { id: 'new-message', type: 'agentMessage', text: 'The complete final answer.' },
    ] });
    block = true;
    memory.changed({ type: 'turn-completed', threadId: 's', turnId: 'new-turn', status: 'completed' });
    expect(memory.status().state).toBe('preparing');
    await entered.promise; // The completion timer, not a search/read, starts this sync.
    const pending = memory.synchronize();
    memory.changed({ type: 'sessions-changed' });
    resume.resolve(); await pending;
    expect(memory.status()).toMatchObject({ state: 'ready', processed: 2, total: 2 });
    expect(f.methods.filter(method => method === 'sync.complete')).toHaveLength(2);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    const docs = [...f.stored.values()].flatMap(scope => [...scope.values()].map(item => item.document));
    expect(docs.map(doc => doc.text)).toEqual(['A saved decision about local memory.', 'The complete final answer.']);
  } finally { resume.resolve(); await memory.dispose(); await f.close(); }
});

test('catalog and session creation events do not cancel a running memory summary', async () => {
  const f = await flashFixture();
  const entered = deferred<void>(); const resume = deferred<void>();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => ({ sessions: [session()] }), read: async () => history() },
    summarize: async value => { entered.resolve(); await resume.promise; return fixtureSummary(value); } });
  memory.accounts(account());
  try {
    const pending = memory.execute('memory_read', readRequest(), 's', new AbortController().signal);
    await entered.promise;
    memory.changed({ type: 'sessions-changed' });
    memory.changed({ type: 'session-created', session: { id: 'other' } });
    expect(memory.status()).toEqual(ready);
    resume.resolve();
    expect(await pending).toMatchObject({ summary: 'A saved decision about local memory.' });
    expect(f.methods.filter(method => method === 'sync.complete')).toHaveLength(1);
  } finally { resume.resolve(); await memory.dispose(); await f.close(); }
});

test('a search waits beyond one second and continues automatically with acknowledged progress', async () => {
  const f = await flashFixture();
  const entered = deferred<void>(); const resume = deferred<void>();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => { entered.resolve(); await resume.promise; return { sessions: [session()] }; }, read: async () => history() } });
  memory.accounts(account());
  try {
    expect(memory.status().state).toBe('preparing');
    let finished = false;
    const pending = memory.execute('memory_search', { query: 'memory' }, 'current', new AbortController().signal)
      .then(value => { finished = true; return value; });
    await entered.promise;
    expect(memory.status()).toMatchObject({ state: 'syncing', total: null, waiting: 1 });
    await pause(1100);
    expect(finished).toBe(false);
    expect(f.methods).not.toContain('memory_search');
    resume.resolve();
    expect(await pending).toMatchObject({ matches: [{ text: 'A saved decision about local memory.' }] });
    expect(memory.status()).toEqual(ready);
    memory.resetAccount();
    expect(memory.status()).toEqual({ state: 'signed_out', processed: 0, total: null, waiting: 0, error: null });
  } finally { resume.resolve(); await memory.dispose(); await f.close(); }
});

for (const mode of ['cancel', 'timeout', 'switch'] as const) {
  test(`${mode} retires the waiting search without publishing stale results`, async () => {
    const f = await flashFixture();
    const entered = deferred<void>(); const resume = deferred<void>();
    const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, syncWaitMs: mode === 'timeout' ? 30 : 5000,
      source: { list: async () => { entered.resolve(); await resume.promise; return { sessions: [session()] }; }, read: async () => history() } });
    memory.accounts(account());
    const controller = new AbortController();
    try {
      const result = rejection(() => memory.execute('memory_search', { query: 'q' }, 'current', controller.signal));
      await entered.promise;
      const sync = memory.synchronize();
      const syncResult = sync.catch(error => error);
      if (mode === 'cancel') controller.abort();
      if (mode === 'switch') memory.accounts(account('b'));
      const error = await result;
      if (mode === 'timeout') expect(error).toMatchObject({ code: 'sync_timeout' });
      expect(memory.status().waiting).toBe(0);
      expect(f.methods).not.toContain('memory_search');
      resume.resolve(); await syncResult;
      if (mode === 'switch') expect(memory.status()).toMatchObject({ state: 'preparing', processed: 0, total: null });
      else expect(memory.status()).toEqual(ready);
    } finally { resume.resolve(); await memory.dispose(); await f.close(); }
  });
}

test('sync errors expose recovery, and retry publishes ready only after a successful sync', async () => {
  const f = await flashFixture(); let fail = true;
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => { if (fail) throw new Error('private source details'); return { sessions: [] }; }, read: async () => history() } });
  memory.accounts(account());
  try {
    await rejection(() => memory.synchronize());
    expect(memory.status().state).toBe('error');
    expect(memory.status().error).not.toContain('private');
    fail = false;
    expect(memory.retry().state).toBe('preparing');
    await memory.synchronize();
    expect(memory.status()).toEqual({ ...ready, processed: 0, total: 0 });
  } finally { await memory.dispose(); await f.close(); }
});

test('IPC validates the sender before reading status or retrying and the preload uses the same channels', async () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  let allowed = false; let retries = 0;
  registerFlashMemoryIpc({ handle: (channel, listener) => { handlers.set(channel, listener); } },
    () => { if (!allowed) throw new Error('Untrusted sender'); },
    { status: () => ready, retry: () => { retries++; return ready; } });
  const event = {} as IpcMainInvokeEvent;
  const api = createFlashMemoryApi({ invoke: async (channel: string) => handlers.get(channel)!(event) });
  expect((await rejection(() => api.retry())).message).toBe('Untrusted sender');
  expect(retries).toBe(0);
  allowed = true;
  expect(await api.status()).toEqual(ready);
  expect(await api.retry()).toEqual(ready);
  expect(retries).toBe(1);
  expect([...handlers.keys()]).toEqual([`${FLASH_MEMORY_CHANNEL}:status`, `${FLASH_MEMORY_CHANNEL}:retry`]);
});

test('renderer ignores late polls after retry and disposal, and drops stale ready on connection failure', async () => {
  const old = deferred<FlashMemoryStatus>(); const next = deferred<FlashMemoryStatus>();
  const views: string[] = [];
  const observer = observeFlashMemory({ status: () => old.promise, retry: () => next.promise },
    view => views.push(view.status?.state ?? (view.connectionError ? 'connection_error' : 'pending')), 10000);
  observer.retry(); next.resolve(ready); await pause(0);
  old.resolve({ ...ready, state: 'error' }); await pause(0);
  expect(views).toEqual(['pending', 'ready']);
  observer.stop();
  const late = deferred<FlashMemoryStatus>();
  const stopped = observeFlashMemory({ status: () => late.promise, retry: () => late.promise }, () => views.push('late'));
  stopped.stop(); late.resolve(ready); await pause(0);
  expect(views).not.toContain('late');
  const failed = observeFlashMemory({ status: async () => { throw new Error('IPC failed'); }, retry: async () => ready },
    view => views.push(view.connectionError && view.status === null ? 'connection_error' : 'unexpected'));
  await pause(0); failed.stop();
  expect(views.at(-1)).toBe('connection_error');
});

test('status distinguishes unknown totals, processed messages, waiting, ready and recoverable errors', () => {
  expect(flashStatusPresentation({ ...ready, state: 'syncing', total: null }).detail).toBe('Reading saved conversations…');
  expect(flashStatusPresentation({ ...ready, state: 'syncing', processed: 3, total: 8, waiting: 1 }).detail)
    .toContain('3 / 8 messages synchronized');
  expect(flashStatusPresentation({ ...ready, state: 'syncing', waiting: 1 }).detail).toContain('automatically');
  expect(flashStatusPresentation(ready)).toEqual({ label: 'Ready', detail: '', retryable: false });
  expect(flashStatusPresentation({ ...ready, state: 'error', error: 'Retry' }).retryable).toBe(true);
});


test('SESSION header renders recoverable status and its retry button reaches the API', async () => {
  let state: unknown;
  const reference: { current: unknown } = { current: null };
  let mounted = false;
  let cleanup: (() => void) | undefined;
  let retries = 0;
  const retried = deferred<FlashMemoryStatus>();
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState: (initial: unknown) => { state ??= initial; return [state, (next: unknown) => { state = next; }]; },
      useRef: () => reference,
      useEffect: (effect: () => (() => void)) => { if (!mounted) cleanup = effect(); },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { MessageSquareText: 'icon', RefreshCw: 'retry-icon' },
    '../../cheshiDesktop': { cheshiDesktop: { flashMemory: {
      status: async () => ({ ...ready, state: 'error', error: 'Could not synchronize saved conversations.' }),
      retry: () => { retries++; return retried.promise; },
    } } },
    '../../shared/ui': { SidebarPanelHeader: 'header' },
    '../../shared/ui/TooltipButton': { TooltipButton: 'button' },
    './flashMemoryStatus': { observeFlashMemory, flashStatusPresentation },
    './FlashSessionHeader.module.css': { default: { status: 'status' } },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/FlashSessionHeader.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.FlashSessionHeader;
  if (typeof component !== 'function') throw new Error('Missing header component');
  interface Element { type: unknown; props: Record<string, unknown> }
  const elements = (value: unknown): Element[] => {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value || typeof value !== 'object' || !('props' in value)) return [];
    const element = value as Element;
    return [element, ...elements(element.props.children)];
  };
  const render = () => { const tree = component({ actions: 'session actions' }); mounted = true; return elements(tree); };
  try {
    render(); await pause(0);
    expect(render().find(item => item.type === 'header')?.props.description).toBe('Flash · Error');
    const button = render().find(item => item.type === 'button');
    expect(button?.props['aria-label']).toBe('Retry Flash synchronization');
    if (typeof button?.props.onClick !== 'function') throw new Error('Missing retry handler');
    button.props.onClick(); button.props.onClick();
    expect(retries).toBe(1);
    expect(render().find(item => item.type === 'button')?.props.disabled).toBe(true);
    retried.resolve(ready); await pause(0);
    expect(render().find(item => item.type === 'header')?.props.description).toBe('Flash · Ready');
    expect(render().some(item => item.type === 'button')).toBe(false);
  } finally { cleanup?.(); }
});
