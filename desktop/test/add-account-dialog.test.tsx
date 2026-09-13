import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import * as accountsModel from '../frontend/src/features/account/accountsModel';
import * as accountTypes from '../shared/codex-accounts';
import type { CodexAccountProfile, CodexAccountsApi, CodexAccountsSnapshot } from '../shared/codex-accounts';

interface TestElement { type: unknown; props: Record<string, unknown> }

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || value === null || !('type' in value) || !('props' in value)) return [];
  const element = value as TestElement;
  return [element, ...elements(element.props.children)];
}

function textContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(textContent).join('');
  const element = elements(value)[0];
  return element ? textContent(element.props.children) : typeof value === 'string' ? value : '';
}

function find(tree: TestElement, predicate: (element: TestElement) => boolean): TestElement {
  const element = elements(tree).find(predicate);
  assert.ok(element, 'Expected dialog element');
  return element;
}

async function invoke(element: TestElement, name: string, ...args: unknown[]) {
  const callback = element.props[name];
  assert.ok(typeof callback === 'function', `Expected ${name}`);
  await callback(...args);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function profile(id: string, state: CodexAccountProfile['login']['state']): CodexAccountProfile {
  return { id, label: id, email: state === 'signed_in' ? `${id}@example.com` : null,
    login: { state, error: null }, usage: { state: state === 'signed_in' ? 'ready' : 'login_required',
      authenticated: state === 'signed_in', plan: null, rateLimits: [], error: null } };
}

function snapshot(state: CodexAccountProfile['login']['state'] = 'signed_out'): CodexAccountsSnapshot {
  return { activeId: 'default', profiles: [profile('default', 'signed_in'), profile('created', state)] };
}

type Operations = Partial<Pick<CodexAccountsApi, 'add' | 'login' | 'list' | 'cancelRegistration'>>;

function harness(operations: Operations = {}) {
  const slots: unknown[] = [];
  const mountedEffects = new Set<number>();
  const effects: Array<() => unknown> = [];
  let cursor = 0;
  let closes = 0;
  let listener: ((value: CodexAccountsSnapshot) => void) | null = null;
  const calls: Array<{ method: string; id?: string }> = [];
  const api: CodexAccountsApi = {
    async add() { calls.push({ method: 'add' }); return operations.add ? operations.add() : snapshot(); },
    async login(id) { calls.push({ method: 'login', id }); return operations.login ? operations.login(id) : snapshot('signing_in'); },
    async list() { calls.push({ method: 'list' }); return operations.list ? operations.list() : snapshot('signing_in'); },
    async cancelRegistration(id) {
      calls.push({ method: 'cancelRegistration', id });
      return operations.cancelRegistration ? operations.cancelRegistration(id) : { activeId: 'default', profiles: [profile('default', 'signed_in')] };
    },
    async select(id) { calls.push({ method: 'select', id }); return snapshot(); },
    async logout(id) { calls.push({ method: 'logout', id }); return snapshot(); },
    async cancelLogin(id) { calls.push({ method: 'cancelLogin', id }); return snapshot(); },
    onDidChange(callback) { listener = callback; return () => { listener = null; }; },
  };
  const jsx = (type: unknown, props: Record<string, unknown>): TestElement => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (index >= slots.length) slots[index] = initial;
        return [slots[index], (value: unknown) => { slots[index] = value; }];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        if (index >= slots.length) slots[index] = { current: initial };
        return slots[index];
      },
      useEffect(effect: () => unknown) {
        const index = cursor++;
        if (!mountedEffects.has(index)) { mountedEffects.add(index); effects.push(effect); }
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { UserRoundPlus: 'UserRoundPlus' },
    '../../../../shared/codex-accounts': accountTypes,
    '../../cheshiDesktop': { cheshiDesktop: { codexAccounts: api } },
    '../../shared/ui': { Modal: 'Modal', NeumorphicButton: 'NeumorphicButton', LoadingState: 'LoadingState' },
    './accountsModel': accountsModel,
    './AddAccountDialog.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/account/AddAccountDialog.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.AddAccountDialog;
  assert.ok(typeof component === 'function');
  const render = (): TestElement => {
    cursor = 0;
    const tree = component({ onClose: () => { closes++; } });
    for (const effect of effects.splice(0)) effect();
    return tree;
  };
  return {
    calls, render, get closes() { return closes; },
    emit(value: CodexAccountsSnapshot) { assert.ok(listener); listener(value); },
    submit() { return invoke(find(render(), element => element.type === 'form'), 'onSubmit', { preventDefault() {} }); },
    cancel() { return invoke(find(render(), element => element.props.type === 'button'), 'onClick'); },
  };
}

test('opening the modal and cancelling before sign-in create no account or API request', async () => {
  const app = harness();
  expect(app.render().props.title).toBe('Add account');
  expect(app.calls).toEqual([]);
  await app.cancel();
  expect(app.calls).toEqual([]);
  expect(app.closes).toBe(1);
});

test('submission creates and signs in its appended profile once while duplicate submission is blocked', async () => {
  const addition = createDeferred<CodexAccountsSnapshot>();
  const app = harness({ add: () => addition.promise });
  const pending = app.submit();
  await app.submit();
  expect(app.calls).toEqual([{ method: 'add' }]);
  expect(app.render().props.closeDisabled).toBe(true);
  addition.resolve(snapshot());
  await pending;
  expect(app.calls).toEqual([{ method: 'add' }, { method: 'login', id: 'created' }]);
  expect(textContent(app.render())).toContain('Finish signing in in your browser.');
  await app.submit();
  expect(app.calls).toHaveLength(2);
  expect(app.closes).toBe(0);
});

test('login failure retries the existing created profile without adding another', async () => {
  let attempts = 0;
  const app = harness({ login: async () => {
    if (++attempts === 1) throw new Error('Browser unavailable');
    return snapshot('signing_in');
  } });
  await app.submit();
  expect(textContent(app.render())).toContain('Browser unavailable');
  await app.submit();
  expect(app.calls).toEqual([{ method: 'add' }, { method: 'login', id: 'created' }, { method: 'login', id: 'created' }]);
  expect(textContent(app.render())).not.toContain('Browser unavailable');
});

test('an authenticated update closes only its registration and never selects the account', async () => {
  const app = harness();
  await app.submit();
  app.emit({ activeId: 'default', profiles: [profile('default', 'signed_in'), profile('other', 'signed_in')] });
  expect(app.closes).toBe(0);
  app.emit(snapshot('signed_in'));
  app.emit(snapshot('signed_in'));
  expect(app.closes).toBe(1);
  expect(app.calls.some(call => call.method === 'select')).toBe(false);
});

test('cancelling browser sign-in removes only the newly created registration', async () => {
  const app = harness();
  await app.submit();
  await app.cancel();
  expect(app.calls).toEqual([{ method: 'add' }, { method: 'login', id: 'created' }, { method: 'cancelRegistration', id: 'created' }]);
  expect(app.closes).toBe(1);
});

test('cancellation failure retains the dialog and its profile for retry', async () => {
  const app = harness({ cancelRegistration: async () => { throw new Error('Cancellation unavailable'); } });
  await app.submit();
  await app.cancel();
  expect(app.closes).toBe(0);
  expect(textContent(app.render())).toContain('Cancellation unavailable');
  expect(app.calls.slice(-2)).toEqual([{ method: 'cancelRegistration', id: 'created' }, { method: 'list' }]);
  expect(app.render().props.closeDisabled).toBe(false);
});

test('a sign-in completing during rejected cancellation preserves the account and closes the dialog', async () => {
  const app = harness({ cancelRegistration: async () => { throw new Error('Account has signed in'); },
    list: async () => snapshot('signed_in') });
  await app.submit();
  await app.cancel();
  expect(app.closes).toBe(1);
  expect(app.calls).toEqual([{ method: 'add' }, { method: 'login', id: 'created' },
    { method: 'cancelRegistration', id: 'created' }, { method: 'list' }]);
});

test('a completed sign-in notification survives an older pending login response', async () => {
  const login = createDeferred<CodexAccountsSnapshot>();
  const enteredLogin = createDeferred<void>();
  const app = harness({ login: () => { enteredLogin.resolve(); return login.promise; } });
  const pending = app.submit();
  await enteredLogin.promise;
  app.emit(snapshot('signed_in'));
  login.resolve(snapshot('signing_in'));
  await pending;
  expect(app.closes).toBe(1);
  expect(app.calls).toEqual([{ method: 'add' }, { method: 'login', id: 'created' }]);
});

test('a successful sign-in notification survives stale recovery data after cancellation fails', async () => {
  const cancellation = createDeferred<void>();
  const app = harness({ cancelRegistration: async () => {
    await cancellation.promise;
    throw new Error('Account has signed in');
  }, list: async () => snapshot('signing_in') });
  await app.submit();
  const pending = app.cancel();
  app.emit(snapshot('signed_in'));
  cancellation.resolve();
  await pending;
  expect(app.closes).toBe(1);
  expect(app.calls.some(call => call.method === 'logout' || call.method === 'select')).toBe(false);
});
