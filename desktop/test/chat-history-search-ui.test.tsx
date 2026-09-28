import { describe, expect, mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { NeumorphicButton } from '../frontend/src/shared/ui/NeumorphicButton';
import { SidebarPanelTitle } from '../frontend/src/shared/ui/SidebarPanelHeader';
import { chatHistorySearchRequest, type ChatHistorySearchHit, type ChatHistorySearchResponse } from '../shared/chat-history-search';
import { normalizeChatEvent } from '../frontend/src/features/chat/model';
import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop';
import type { useChatHistorySearch } from '../frontend/src/features/chat/useChatHistorySearch';
import type { ChatHistorySearchBar } from '../frontend/src/features/chat/ChatHistorySearchBar';
import type { ChatHistorySearchPage } from '../frontend/src/features/chat/ChatHistorySearchPage';
import { chatHistoryItemMatches, findChatHistoryTarget } from '../frontend/src/features/chat/chatHistorySearchNavigation';
import { captureChatHistoryAnchor, previousChatHistoryStart } from '../frontend/src/features/chat/chatHistoryWindow';
import { groupReasoningItems } from '../frontend/src/features/chat/chatReasoningPresentation';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatHistorySearchResults } = await import('../frontend/src/features/chat/ChatHistorySearchPage');
const { ChatTimelineHistory } = await import('../frontend/src/features/chat/ChatTimelineHistory');

const hit: ChatHistorySearchHit = {
  threadId: 'thread-one', turnId: 'turn-one', itemId: 'item-one', title: 'Fix session loading',
  snippet: '원문 기록과 <script>literal source</script>', kind: 'assistant', updatedAt: 123,
  files: [{ path: 'desktop/lib/chat.mts', kind: 'mentioned' }, { path: 'README.md', kind: 'changed' }], duplicateCount: 1,
};
const response = (hits = [hit]): ChatHistorySearchResponse => ({ hits, total: hits.length, indexedSessions: 2, unavailableSessions: [] });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

interface HookSlot { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }
function createHarness<Args extends unknown[], Result>(filename: string, exportName: string, dependencies: Record<string, unknown>) {
  const slots: HookSlot[] = [];
  const effects: Array<() => void> = [];
  const frames = new Map<number, () => void>();
  const timeouts = new Map<number, { at: number; callback: () => void }>();
  let frameId = 0;
  let timeoutId = 0;
  let now = 0;
  let cursor = 0;
  const nextSlot = () => slots[cursor++] ??= {};
  const same = (before: readonly unknown[] | undefined, after: readonly unknown[]) =>
    before?.length === after.length && after.every((value, index) => Object.is(value, before[index]));
  const useEffect = (effect: () => void | (() => void), values: readonly unknown[]) => {
    const slot = nextSlot();
    if (same(slot.dependencies, values)) return;
    slot.dependencies = values;
    effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() ?? undefined; });
  };
  const react = {
    useState(initial: unknown) {
      const slot = nextSlot();
      if (!Object.hasOwn(slot, 'value')) slot.value = typeof initial === 'function' ? initial() : initial;
      return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
    },
    useRef(initial: unknown) { const slot = nextSlot(); return slot.value ??= { current: initial }; },
    useMemo(factory: () => unknown, values: readonly unknown[]) {
      const slot = nextSlot();
      if (!same(slot.dependencies, values)) { slot.dependencies = values; slot.value = factory(); }
      return slot.value;
    },
    useCallback(value: unknown, values: readonly unknown[]) {
      const slot = nextSlot();
      if (!same(slot.dependencies, values)) { slot.dependencies = values; slot.value = value; }
      return slot.value;
    },
    useEffect,
    useLayoutEffect: useEffect,
    memo: (component: unknown) => component,
  };
  const source = readFileSync(new URL(`../frontend/src/features/chat/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: Record<string, unknown> = {};
  const modules: Record<string, unknown> = { ...dependencies, react };
  vm.runInNewContext(compiled.outputText, {
    exports, Error,
    Date: class extends Date { static now() { return now; } },
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; },
    window: { requestAnimationFrame(callback: () => void) { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame(id: number) { frames.delete(id); },
      setTimeout(callback: () => void, delay: number) { timeouts.set(++timeoutId, { at: now + delay, callback }); return timeoutId; },
      clearTimeout(id: number) { timeouts.delete(id); } },
  });
  const exported = exports[exportName];
  assert.ok(typeof exported === 'function');
  return {
    render(...args: Args): Result { cursor = 0; return exported(...args); },
    flushEffects() { for (const effect of effects.splice(0)) effect(); },
    flushFrames() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    advanceTime(duration: number) {
      now += duration;
      for (const [id, timeout] of timeouts) {
        if (timeout.at <= now) { timeouts.delete(id); timeout.callback(); }
      }
    },
    pendingTimers() { return timeouts.size; },
    dispose() { for (const slot of slots) slot.cleanup?.(); },
  };
}

function searchHarness(searchCodexChatHistory: CheshiDesktopApi['searchCodexChatHistory']) {
  const listeners = new Map<string | undefined, Set<(value: unknown) => void>>();
  const onCodexChatEvent: CheshiDesktopApi['onCodexChatEvent'] = (listener, contextId) => {
    const entries = listeners.get(contextId) ?? new Set();
    entries.add(listener);
    listeners.set(contextId, entries);
    return () => { entries.delete(listener); };
  };
  const harness = createHarness<[contextId: string, workspaceContextIds?: readonly string[]], ReturnType<typeof useChatHistorySearch>>('useChatHistorySearch.ts', 'useChatHistorySearch', {
    '../../cheshiDesktop': { cheshiDesktop: { searchCodexChatHistory, onCodexChatEvent } },
    '../../shared/errorMessage': { errorMessage: (reason: unknown) => reason instanceof Error ? reason.message : String(reason) },
    '../../../../shared/chat-history-search': { chatHistorySearchRequest },
    './model': { normalizeChatEvent },
  });
  return { ...harness,
    emit(value: unknown, contextId = 'pane') { listeners.get(contextId)?.forEach(listener => listener(value)); },
    listenerCount() { return [...listeners.values()].reduce((count, entries) => count + entries.size, 0); },
  };
}

describe('chat search requests', () => {
  test('reuses normalized search results immediately for at most 300 seconds without extending expiry on hits', async () => {
    let calls = 0;
    const harness = searchHarness(async () => { calls += 1; return response(); });
    harness.render('pane'); harness.flushEffects();
    await harness.render('pane').search({ query: '  HELLO   한글  ' });
    harness.render('pane').clear();
    harness.advanceTime(299_999);
    const cached = harness.render('pane').search({ query: 'hello 한글'.normalize('NFD'), refresh: false, limit: 50 });
    expect(harness.render('pane').loading).toBe(false);
    expect(harness.render('pane').result?.hits).toEqual([hit]);
    await cached;
    expect(calls).toBe(1);
    harness.advanceTime(1);
    await harness.render('pane').search({ query: 'hello 한글' });
    expect(calls).toBe(2);
    harness.dispose();
  });

  test('keeps query, file filter and result limit separate and caches empty results', async () => {
    let calls = 0;
    const harness = searchHarness(async () => { calls += 1; return response([]); });
    harness.render('pane'); harness.flushEffects();
    const requests = [{ query: 'first' }, { query: 'second' }, { query: 'first', filePath: 'README.md' }, { query: 'first', limit: 1 }];
    for (const request of requests) await harness.render('pane').search(request);
    for (const request of requests) {
      harness.render('pane').clear();
      await harness.render('pane').search(request);
      expect(harness.render('pane').result?.total).toBe(0);
    }
    expect(calls).toBe(4);
    harness.dispose();
  });

  test('shares an in-flight request across repeated submissions and input edits', async () => {
    let calls = 0;
    const pending = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async () => { calls += 1; return pending.promise; });
    harness.render('pane'); harness.flushEffects();
    const first = harness.render('pane').search({ query: 'same' });
    harness.render('pane').clear();
    const second = harness.render('pane').search({ query: ' same ', limit: 50 });
    expect(calls).toBe(1);
    expect(harness.render('pane').loading).toBe(true);
    pending.resolve(response());
    await Promise.all([first, second]);
    expect(harness.render('pane').result?.hits).toEqual([hit]);
    expect(harness.render('pane').loading).toBe(false);
    harness.dispose();
  });

  test('refresh bypasses cached results and normal pending work, but concurrent refreshes share a request', async () => {
    const old = createDeferred<ChatHistorySearchResponse>();
    const fresh = createDeferred<ChatHistorySearchResponse>();
    let calls = 0;
    const harness = searchHarness(async request => { calls += 1; return request.refresh ? fresh.promise : old.promise; });
    harness.render('pane'); harness.flushEffects();
    const first = harness.render('pane').search({ query: 'same' });
    const refresh = harness.render('pane').search({ query: 'same', refresh: true });
    const repeated = harness.render('pane').search({ query: 'same', refresh: true });
    const joined = harness.render('pane').search({ query: 'same' });
    expect(calls).toBe(2);
    fresh.resolve(response([{ ...hit, snippet: 'fresh' }]));
    await Promise.all([refresh, repeated, joined]);
    old.resolve(response([{ ...hit, snippet: 'old' }]));
    await first;
    await harness.render('pane').search({ query: 'same' });
    expect(calls).toBe(2);
    expect(harness.render('pane').result?.hits[0]?.snippet).toBe('fresh');
    await harness.render('pane').search({ query: 'same', refresh: true });
    expect(calls).toBe(3);
    harness.dispose();
  });

  test('a failed refresh cannot fall back to the old cached response', async () => {
    let calls = 0;
    const harness = searchHarness(async request => {
      calls += 1;
      if (request.refresh) throw new Error('Refresh failed');
      return response();
    });
    harness.render('pane'); harness.flushEffects();
    await harness.render('pane').search({ query: 'same' });
    await harness.render('pane').search({ query: 'same', refresh: true });
    expect(harness.render('pane').result).toBeNull();
    expect(harness.render('pane').error).toBe('Refresh failed');
    await harness.render('pane').search({ query: 'same' });
    expect(calls).toBe(3);
    expect(harness.render('pane').error).toBeNull();
    harness.dispose();
  });

  test('partial results remain retryable instead of being cached for five minutes', async () => {
    let calls = 0;
    const harness = searchHarness(async () => { calls += 1; return { ...response(), unavailableSessions: ['missing'] }; });
    harness.render('pane'); harness.flushEffects();
    await harness.render('pane').search({ query: 'same' });
    await harness.render('pane').search({ query: 'same' });
    expect(calls).toBe(2);
    harness.dispose();
  });

  test.each([
    { type: 'sessions-changed' },
    { type: 'session-created', session: { id: 'thread-new', title: 'New conversation' } },
    { type: 'sessions-deleted', threadIds: ['thread-one'] },
    { type: 'session-title', threadId: 'thread-one', title: 'renamed' },
    { type: 'turn-started', threadId: 'thread-one' },
    { type: 'turn-completed', threadId: 'thread-one', status: 'completed' },
    { type: 'assistant-delta', threadId: 'thread-one', itemId: 'item-one', text: 'new text' },
    { type: 'user-message', threadId: 'thread-one', clientMessageId: 'client-one', text: 'new prompt' },
  ])('invalidates results on history mutation: $type', async event => {
    let calls = 0;
    const harness = searchHarness(async () => { calls += 1; return response(); });
    harness.render('pane'); harness.flushEffects();
    await harness.render('pane').search({ query: 'same' });
    harness.emit(event);
    await harness.render('pane').search({ query: 'same' });
    expect(calls).toBe(2);
    harness.dispose();
  });

  test('observes all workspace panes, ignores unrelated events, and removes event subscriptions', async () => {
    let calls = 0;
    const contexts = ['pane', 'other-pane'];
    const harness = searchHarness(async () => { calls += 1; return response(); });
    harness.render('pane', contexts); harness.flushEffects();
    expect(harness.listenerCount()).toBe(2);
    await harness.render('pane', contexts).search({ query: 'same' });
    harness.emit({ type: 'session-selected', threadId: 'thread-one' });
    harness.emit({ type: 'permission-mode-changed', mode: 'unknown' });
    harness.emit({ type: 'sessions-deleted', threadIds: [] });
    await harness.render('pane', contexts).search({ query: 'same' });
    expect(calls).toBe(1);
    harness.emit({ type: 'sessions-changed' }, 'other-pane');
    await harness.render('pane', contexts).search({ query: 'same' });
    expect(calls).toBe(2);
    harness.dispose();
    expect(harness.listenerCount()).toBe(0);
  });

  test('a history change during a request prevents the response from repopulating the cache', async () => {
    let calls = 0;
    const old = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async () => { calls += 1; return calls === 1 ? old.promise : response([]); });
    harness.render('pane'); harness.flushEffects();
    const first = harness.render('pane').search({ query: 'same' });
    harness.emit({ type: 'sessions-changed' });
    old.resolve(response()); await first;
    await harness.render('pane').search({ query: 'same' });
    expect(calls).toBe(2);
    expect(harness.render('pane').result?.hits).toEqual([]);
    harness.dispose();
  });

  test('deletion invalidates pending searches and cannot resurrect deleted visible results', async () => {
    let calls = 0;
    const old = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async () => { calls += 1; return calls === 1 ? old.promise : response([]); });
    harness.render('pane'); harness.flushEffects();
    const first = harness.render('pane').search({ query: 'same' });
    harness.emit({ type: 'sessions-deleted', threadIds: ['thread-one'] });
    old.resolve(response()); await first;
    expect(harness.render('pane').result).toBeNull();
    expect(harness.render('pane').loading).toBe(false);
    await harness.render('pane').search({ query: 'same' });
    expect(calls).toBe(2);
    harness.dispose();
  });

  test('account reset drops cached and pending searches even when the pane id stays the same', async () => {
    let calls = 0;
    const old = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async () => { calls += 1; return calls === 2 ? old.promise : response(); });
    harness.render('pane'); harness.flushEffects();
    await harness.render('pane').search({ query: 'cached' });
    const first = harness.render('pane').search({ query: 'pending' });
    harness.render('pane').reset();
    old.resolve(response()); await first;
    expect(harness.render('pane').result).toBeNull();
    await harness.render('pane').search({ query: 'cached' });
    await harness.render('pane').search({ query: 'pending' });
    expect(calls).toBe(4);
    harness.dispose();
  });

  test('switching context and returning to the original pane does not reuse its cached results', async () => {
    let calls = 0;
    const harness = searchHarness(async () => { calls += 1; return response(); });
    for (const context of ['pane', 'other-pane', 'pane']) {
      harness.render(context); harness.flushEffects();
      await harness.render(context).search({ query: 'same' });
    }
    expect(calls).toBe(3);
    harness.dispose();
  });

  test('bounds cache memory and evicts the least recently used result', async () => {
    let calls = 0;
    const harness = searchHarness(async () => { calls += 1; return response(); });
    harness.render('pane'); harness.flushEffects();
    for (let index = 0; index < 50; index += 1) await harness.render('pane').search({ query: String(index) });
    await harness.render('pane').search({ query: '0' });
    await harness.render('pane').search({ query: '50' });
    await harness.render('pane').search({ query: '0' });
    expect(calls).toBe(51);
    await harness.render('pane').search({ query: '1' });
    expect(calls).toBe(52);
    harness.dispose();
  });

  test('does not read histories before submit and forwards file-only searches to the selected context', async () => {
    const requests: Parameters<CheshiDesktopApi['searchCodexChatHistory']>[] = [];
    const harness = searchHarness(async (...args) => { requests.push(args); return response(); });
    harness.render('pane-one'); harness.flushEffects();
    expect(requests).toEqual([]);
    await harness.render('pane-one').search({ query: '', filePath: 'README.md', refresh: true, limit: 50 });
    expect(requests).toEqual([[{ query: '', filePath: 'README.md', refresh: true, limit: 50 }, 'pane-one']]);
    expect(harness.render('pane-one').result?.hits).toEqual([hit]);
  });

  test('late search responses cannot replace a newer result', async () => {
    const old = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async (request) => request.query === 'old' ? old.promise : response([{ ...hit, snippet: 'new' }]));
    harness.render('pane'); harness.flushEffects();
    const oldRequest = harness.render('pane').search({ query: 'old' });
    await harness.render('pane').search({ query: 'new' });
    old.resolve(response([{ ...hit, snippet: 'old' }]));
    await oldRequest;
    expect(harness.render('pane').result?.hits[0]?.snippet).toBe('new');
    expect(harness.render('pane').loading).toBe(false);
  });

  test('editing the search invalidates in-flight results and failures', async () => {
    const old = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async () => old.promise);
    harness.render('pane'); harness.flushEffects();
    const request = harness.render('pane').search({ query: 'old' });
    harness.render('pane').clear();
    old.reject(new Error('Old request failed'));
    await request;
    const state = harness.render('pane');
    expect(state.result).toBeNull(); expect(state.error).toBeNull(); expect(state.loading).toBe(false);
  });

  test('context changes discard pending responses from the previous pane', async () => {
    const old = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async (_request, contextId) => contextId === 'old' ? old.promise : response([]));
    harness.render('old'); harness.flushEffects();
    const request = harness.render('old').search({ query: 'text' });
    harness.render('new'); harness.flushEffects();
    await harness.render('new').search({ query: 'text' });
    old.resolve(response()); await request;
    expect(harness.render('new').result?.hits).toEqual([]);
  });

  test('a current failure is shown while a disposed search ignores late completion', async () => {
    const pending = createDeferred<ChatHistorySearchResponse>();
    const harness = searchHarness(async (request) => {
      if (request.query === 'fail') throw new Error('History unavailable');
      return pending.promise;
    });
    harness.render('pane'); harness.flushEffects();
    await harness.render('pane').search({ query: 'fail' });
    expect(harness.render('pane').error).toBe('History unavailable');
    const request = harness.render('pane').search({ query: 'later' });
    harness.dispose(); pending.resolve(response()); await request;
    expect(harness.render('pane').result).toBeNull();
  });
});

interface SearchElementProps {
  children?: ReactNode;
  'aria-label'?: string;
  disabled?: boolean;
  ref?: { current: { focus(): void } | null };
  onSubmit?: (event: { preventDefault(): void }) => void;
  onKeyDown?: (event: { key: string; nativeEvent: { isComposing: boolean }; preventDefault(): void }) => void;
  onClick?: () => void;
  onOpen?: (value: ChatHistorySearchHit) => void;
  trailingAction?: ReactNode;
  item?: { id: string };
  searchMatch?: boolean;
}
function searchElements(node: ReactNode): ReactElement<SearchElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(searchElements);
  if (!isValidElement<SearchElementProps>(node)) return [];
  return [node, ...searchElements(node.props.children), ...searchElements(node.props.trailingAction)];
}
function searchElement(node: ReactNode, label: string): ReactElement<SearchElementProps> {
  const element = searchElements(node).find(value => value.props['aria-label'] === label);
  assert.ok(element, `Missing search control: ${label}`);
  return element;
}
const searchUiDependencies = {
  'react/jsx-runtime': jsxRuntime,
  'lucide-react': { Search: 'svg', X: 'svg', PanelRight: 'svg', RefreshCw: 'svg' },
  '../../shared/ui': { NeumorphicButton, SidebarToggle: NeumorphicButton, NeumorphicTextField: 'input', SearchClearButton: 'button',
    TieredHeader: ({ primary }: { primary: ReactNode }) => jsxRuntime.jsx('header', { children: primary }), LoadingState: 'progress' },
  '../../shared/ui/SidebarPanelHeader': { SidebarPanelTitle },
  '../../shared/errorMessage': { errorMessage: (reason: unknown) => reason instanceof Error ? reason.message : String(reason) },
  './ChatHistorySearch.module.css': { default: {} },
};
type SearchBarProps = ComponentProps<typeof ChatHistorySearchBar>;
type SearchPageProps = ComponentProps<typeof ChatHistorySearchPage>;

describe('unified search bar', () => {
  test('Enter submits a combined query and ignores empty or disabled submissions', () => {
    const harness = createHarness<[SearchBarProps], ReactElement>('ChatHistorySearchBar.tsx', 'ChatHistorySearchBar', searchUiDependencies);
    let submissions = 0;
    let prevented = 0;
    const props: SearchBarProps = { query: '세션 desktop/lib/chat.mts', disabled: false,
      onQueryChange() {}, onFocus() {}, onSubmit() { submissions += 1; } };
    for (const update of [{}, { query: '  ' }, { disabled: true }]) {
      searchElement(harness.render({ ...props, ...update }), 'Conversation search').props.onSubmit?.({
        preventDefault() { prevented += 1; },
      });
    }
    expect(submissions).toBe(1);
    expect(prevented).toBe(3);
  });

  test('clearing removes the query and returns focus to the unified input', () => {
    const harness = createHarness<[SearchBarProps], ReactElement>('ChatHistorySearchBar.tsx', 'ChatHistorySearchBar', searchUiDependencies);
    const values: string[] = [];
    let focuses = 0;
    const props: SearchBarProps = { query: 'README.md', disabled: false,
      onQueryChange(value) { values.push(value); }, onFocus() {}, onSubmit() {} };
    const tree = harness.render(props);
    const input = searchElement(tree, 'Search messages, tool activity, and file paths');
    assert.ok(input.props.ref);
    input.props.ref.current = { focus() { focuses += 1; } };
    searchElement(tree, 'Clear search').props.onClick?.();
    expect(values).toEqual(['']);
    expect(focuses).toBe(1);
    expect(searchElements(harness.render({ ...props, query: '' })).some(value => value.props['aria-label'] === 'Clear search')).toBe(false);
  });

  test('Enter confirms Korean composition before submitting a search', () => {
    const harness = createHarness<[SearchBarProps], ReactElement>('ChatHistorySearchBar.tsx', 'ChatHistorySearchBar', searchUiDependencies);
    const tree = harness.render({ query: '세션', disabled: false, onQueryChange() {}, onFocus() {}, onSubmit() {} });
    const input = searchElement(tree, 'Search messages, tool activity, and file paths');
    for (const isComposing of [true, false]) {
      let prevented = false;
      input.props.onKeyDown?.({ key: 'Enter', nativeEvent: { isComposing }, preventDefault() { prevented = true; } });
      expect(prevented).toBe(isComposing);
    }
  });
});

function pageProps(onOpen: SearchPageProps['onOpen']): SearchPageProps {
  return { query: 'session', result: response(), loading: false, error: null, selectionDisabled: false,
    onOpen, onRefresh() {}, onClose() {}, rightSidebarOpen: true, onToggleRightSidebar() {} };
}
function openPageResult(tree: ReactNode): void {
  const result = searchElements(tree).find(element => typeof element.props.onOpen === 'function');
  assert.ok(result?.props.onOpen, 'Search result must navigate to the original message');
  result.props.onOpen(hit);
}

describe('search page original navigation', () => {
  test('repeated clicks open once and a current failure is shown', async () => {
    const harness = createHarness<[SearchPageProps], ReactElement>('ChatHistorySearchPage.tsx', 'ChatHistorySearchPage', searchUiDependencies);
    const pending = createDeferred<boolean>();
    let opens = 0;
    const props = pageProps(() => { opens += 1; return pending.promise; });
    harness.render(props); harness.flushEffects();
    const tree = harness.render(props);
    openPageResult(tree); openPageResult(tree);
    expect(opens).toBe(1);
    pending.resolve(false); await pending.promise;
    expect(renderToStaticMarkup(harness.render(props))).toContain('Could not open the original conversation.');
    harness.dispose();
  });

  test('changing the query ignores a late original-conversation failure', async () => {
    const harness = createHarness<[SearchPageProps], ReactElement>('ChatHistorySearchPage.tsx', 'ChatHistorySearchPage', searchUiDependencies);
    const pending = createDeferred<boolean>();
    const props = pageProps(() => pending.promise);
    harness.render(props); harness.flushEffects();
    openPageResult(harness.render(props));
    const nextProps = { ...props, query: '', result: null };
    harness.render(nextProps); harness.flushEffects();
    pending.resolve(false); await pending.promise;
    const markup = renderToStaticMarkup(harness.render(nextProps));
    expect(markup).not.toContain('Could not open the original conversation.');
    expect(markup).not.toContain('Opening original message');
    harness.dispose();
  });
});

describe('chat search result presentation', () => {
  test('matching results group the escaped query and match count in one header', () => {
    const html = renderToStaticMarkup(<ChatHistorySearchResults query="  <오잉?>  " result={response()} disabled={false} onOpen={() => {}} />);
    const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
    expect(header).toBeDefined();
    expect(header).toContain('Results for &lt;오잉?&gt;');
    expect(header).toContain('1 of 1 matches · 2 conversations searched');
    expect(html.match(/<header\b/g)).toHaveLength(1);
  });

  test('empty results show the escaped query and retry guidance without a summary or icon', () => {
    const html = renderToStaticMarkup(<ChatHistorySearchResults query="  <오잉?>  " result={response([])} disabled={false} onOpen={() => {}} />);
    expect(html).toContain('No results for “&lt;오잉?&gt;”');
    expect(html).toContain('Try another word, filename, or file path.');
    expect(html).not.toContain('conversations searched');
    expect(html).not.toContain('<header');
    expect(html).not.toContain('<svg');
  });

  test('the page hides the query summary while loading and for empty results, then restores it for matches', () => {
    const harness = createHarness<[SearchPageProps], ReactElement>('ChatHistorySearchPage.tsx', 'ChatHistorySearchPage', searchUiDependencies);
    const props = pageProps(async () => true);
    const loading = renderToStaticMarkup(harness.render({ ...props, result: null, loading: true }));
    expect(loading).not.toContain('Results for');
    const empty = renderToStaticMarkup(harness.render({ ...props, result: response([]) }));
    expect(empty).not.toContain('Results for');
    expect(empty).not.toContain('conversations searched');
    expect(empty).toContain('No results for “session”');
    const matches = renderToStaticMarkup(harness.render(props));
    expect(matches).toContain('Results for');
    expect(matches).toContain('1 of 1 matches');
    harness.dispose();
  });

  test('shows escaped source text, distinct file evidence and additional fork copies', () => {
    const html = renderToStaticMarkup(<ChatHistorySearchResults query="session" result={response()} disabled={false} onOpen={() => {}} />);
    expect(html).toContain('원문 기록과 &lt;script&gt;literal source&lt;/script&gt;');
    expect(html).toContain('Mentioned · desktop/lib/chat.mts');
    expect(html).toContain('Changed · README.md');
    expect(html).toContain('Turn turn-one · +1 copy');
    expect(html).toContain('Open original message: Fix session loading');
  });

  test('partial empty results explicitly distinguish unavailable conversations', () => {
    const html = renderToStaticMarkup(<ChatHistorySearchResults query="session" result={{ ...response([]), unavailableSessions: ['unread'] }} disabled onOpen={() => {}} />);
    expect(html).toContain('1 conversations could not be searched');
    expect(html).toContain('No matches in the available conversations.');
    expect(html).not.toContain('No results for');
  });
});

type HistoryProps = ComponentProps<typeof ChatTimelineHistory>;
function timelineProps(): HistoryProps {
  return { items: Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, kind: 'assistant', text: `Message ${index}`, createdAt: 1 })),
    timelineRef: { current: null }, loading: false, streaming: false, completedTurns: new Map(), onReviewFileChanges() {} };
}
function historyHarness() {
  return createHarness<[HistoryProps], ReactNode>('ChatTimelineHistory.tsx', 'ChatTimelineHistory', {
    'react/jsx-runtime': jsxRuntime,
    '../../shared/ui': { NeumorphicButton: 'button' },
    './ChatTimelineItem': { ChatTimelineItem: 'timeline-item' },
    './HistoryRecallActivity': { HistoryRecallTotals: 'history-recall-totals', recallTurnMetrics: () => new Map() },
    './chatHistoryWindow': { captureChatHistoryAnchor, previousChatHistoryStart },
    './chatReasoningPresentation': { groupReasoningItems },
    './ChatView.module.css': { default: { reasoningGroup: 'reasoning-group' } },
    './chatHistorySearchNavigation': { chatHistoryItemMatches, findChatHistoryTarget },
  });
}

function highlightedHistoryItems(tree: ReactNode): string[] {
  return searchElements(tree).filter(element => element.props.searchMatch)
    .map(element => element.props.item!.id);
}

function navigableHistoryProps(): HistoryProps {
  return { ...timelineProps(), historyTarget: { threadId: 'thread', itemId: 'item-4', requestId: 1 },
    timelineRef: { current: { scrollTop: 0, querySelectorAll: () => [{ dataset: { chatItemId: 'item-4' } }],
      addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement } };
}

describe('chat search original message navigation', () => {
  test('reveals a live user message by its provider id without replacing its mounted row', () => {
    const harness = historyHarness();
    const outcomes: boolean[] = [];
    const revealed: string[] = [];
    const props = navigableHistoryProps();
    props.items[4] = { id: 'client:local-user', providerItemId: 'server-user', kind: 'user', text: 'Find this prompt', createdAt: 1 };
    props.timelineRef = { current: { scrollTop: 0,
      querySelectorAll: () => [{ dataset: { chatItemId: 'client:local-user' } }],
      addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement };
    props.onRevealHistoryItem = item => { revealed.push(item.dataset.chatItemId!); };
    props.onHistoryTargetHandled = (_request, found) => { outcomes.push(found); };
    for (const requestId of [1, 2]) {
      props.historyTarget = { threadId: 'thread', itemId: 'server-user', requestId };
      harness.render(props); harness.flushEffects(); harness.flushFrames();
      expect(highlightedHistoryItems(harness.render({ ...props, historyTarget: null }))).toEqual(['client:local-user']);
      harness.flushEffects();
    }
    expect(outcomes).toEqual([true, true]);
    expect(revealed).toEqual(['client:local-user', 'client:local-user']);
    harness.dispose();
  });

  test('clears the destination highlight after two seconds even when navigation has been acknowledged', () => {
    const harness = historyHarness();
    const props = navigableHistoryProps();
    harness.render(props); harness.flushEffects(); harness.flushFrames();
    const acknowledged = { ...props, historyTarget: null };
    expect(highlightedHistoryItems(harness.render(acknowledged))).toEqual(['item-4']);
    harness.flushEffects();
    harness.advanceTime(1_999);
    expect(highlightedHistoryItems(harness.render(acknowledged))).toEqual(['item-4']);
    harness.advanceTime(1);
    expect(highlightedHistoryItems(harness.render(acknowledged))).toEqual([]);
    harness.flushEffects(); harness.dispose();
  });

  test('revisiting the same result restarts the highlight without the old timer clearing it early', () => {
    const harness = historyHarness();
    const props = navigableHistoryProps();
    harness.render(props); harness.flushEffects(); harness.flushFrames();
    harness.render({ ...props, historyTarget: null }); harness.flushEffects();
    harness.advanceTime(1_000);
    const next = { ...props, historyTarget: { threadId: 'thread', itemId: 'item-4', requestId: 2 } };
    harness.render(next); harness.flushEffects(); harness.flushFrames();
    const acknowledged = { ...next, historyTarget: null };
    harness.render(acknowledged); harness.flushEffects();
    expect(harness.pendingTimers()).toBe(1);
    harness.advanceTime(1_000);
    expect(highlightedHistoryItems(harness.render(acknowledged))).toEqual(['item-4']);
    harness.advanceTime(1_000);
    expect(highlightedHistoryItems(harness.render(acknowledged))).toEqual([]);
    harness.flushEffects(); harness.dispose();
  });

  test('removing the conversation cancels pending highlight cleanup', () => {
    const harness = historyHarness();
    const props = navigableHistoryProps();
    harness.render(props); harness.flushEffects(); harness.flushFrames();
    harness.render({ ...props, historyTarget: null }); harness.flushEffects();
    expect(harness.pendingTimers()).toBe(1);
    harness.dispose();
    expect(harness.pendingTimers()).toBe(0);
  });

  test('a target outside the latest page is included in the first rendered history', () => {
    const html = renderToStaticMarkup(<ChatTimelineHistory {...timelineProps()}
      historyTarget={{ threadId: 'thread', itemId: 'item-4', requestId: 1 }} />);
    expect(html).toContain('data-chat-item-id="item-4"');
    expect(html).toContain('data-chat-item-id="item-99"');
    expect(html).not.toContain('data-chat-item-id="item-3"');
  });

  test('reveals and focuses an original item before acknowledging the target', () => {
    const harness = historyHarness();
    const events: string[] = [];
    const element = { dataset: { chatItemId: 'item-4' } };
    const props: HistoryProps = { ...timelineProps(), historyTarget: { threadId: 'thread', itemId: 'item-4', requestId: 5 },
      timelineRef: { current: { scrollTop: 0, querySelectorAll: () => [element], addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement },
      onRevealHistoryItem(item) { expect(item.dataset.chatItemId).toBe(element.dataset.chatItemId); events.push('reveal'); },
      onHistoryTargetHandled(id) { events.push(`handled:${id}`); } };
    harness.render(props); harness.flushEffects(); harness.flushFrames();
    expect(events).toEqual(['reveal', 'handled:5']);
  });

  test('missing original items report navigation failure without scrolling elsewhere', () => {
    const harness = historyHarness();
    const outcomes: boolean[] = [];
    const props: HistoryProps = { ...timelineProps(), historyTarget: { threadId: 'thread', itemId: 'missing', requestId: 7 },
      timelineRef: { current: { scrollTop: 0, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement },
      onRevealHistoryItem() { throw new Error('Unexpected navigation'); },
      onHistoryTargetHandled(_requestId, found) { outcomes.push(found); } };
    harness.render(props); harness.flushEffects(); harness.flushFrames();
    expect(outcomes).toEqual([false]);
  });

  test('a stale target cannot focus its old session after a newer target replaces it', () => {
    const harness = historyHarness();
    const revealed: string[] = [];
    const props: HistoryProps = { ...timelineProps(), historyTarget: { threadId: 'thread', itemId: 'item-4', requestId: 1 },
      timelineRef: { current: { scrollTop: 0, querySelectorAll: () => [{ dataset: { chatItemId: 'item-4' } }, { dataset: { chatItemId: 'item-8' } }],
        addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement },
      onRevealHistoryItem(item) { revealed.push(item.dataset.chatItemId!); } };
    harness.render(props); harness.flushEffects();
    harness.render({ ...props, historyTarget: { threadId: 'thread', itemId: 'item-8', requestId: 2 } }); harness.flushEffects();
    harness.flushFrames();
    expect(revealed).toEqual(['item-8']);
  });
});
