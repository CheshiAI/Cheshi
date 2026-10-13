import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import ts from 'typescript';
import type { WorkspaceStatusBar } from '../frontend/src/features/shell/WorkspaceStatusBar';
import { accountStatusSummary, accountUsageTotals } from '../frontend/src/features/shell/statusBarModel';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts';

interface TestElement {
  type: unknown;
  props: Record<string, unknown>;
}

function isElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isElement(value) ? [value, ...elements(value.props.children)] : [];
}

function content(value: unknown): string {
  if (Array.isArray(value)) return value.map(content).join('');
  if (isElement(value)) return content(value.props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function find(tree: TestElement, predicate: (element: TestElement) => boolean): TestElement {
  const element = elements(tree).find(predicate);
  assert.ok(element, 'Expected status bar element');
  return element;
}

function invoke(element: TestElement, name: string, ...args: unknown[]) {
  const callback = element.props[name];
  assert.ok(typeof callback === 'function', `Expected ${name} callback`);
  callback(...args);
}

// Inspect the actual component's render tree while isolating hooks and child subscriptions.
function harness(props: ComponentProps<typeof WorkspaceStatusBar>) {
  const states: unknown[] = [];
  let cursor = 0;
  let idCursor = 0;
  let hiddenPopovers = 0;
  const jsx = (type: unknown, properties: Record<string, unknown>): TestElement => ({ type, props: properties });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (index >= states.length) states[index] = initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
      useId: () => `status-${idCursor++}`,
      useRef: (current: unknown) => ({ current }),
      useCallback: (callback: unknown) => callback,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'lucide-react': { Gauge: 'Gauge' },
    '../../shared/ui': { LiquidGlassPanel: 'LiquidGlassPanel' },
    '../account/AccountUsagePanel': { AccountUsagePanel: 'AccountUsagePanel' },
    '../account/AddAccountDialog': { AddAccountDialog: 'AddAccountDialog' },
    '../updates/AppUpdateIndicator': { AppUpdateIndicator: 'AppUpdateIndicator' },
    '../chrome/KeepAwakeStatus': { KeepAwakeStatus: 'KeepAwakeStatus' },
    './LanguageSelector': { LanguageSelector: 'LanguageSelector' },
    './statusBarModel': { accountStatusSummary, accountUsageTotals },
    './WorkspaceStatusBar.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/shell/WorkspaceStatusBar.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports,
    document: { getElementById: () => ({ hidePopover: () => { hiddenPopovers++; } }) },
    require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.WorkspaceStatusBar;
  assert.ok(typeof component === 'function');
  return {
    get hiddenPopovers() { return hiddenPopovers; },
    render(): TestElement {
      cursor = 0;
      idCursor = 0;
      return component(props);
    },
  };
}

const initialProps = { onAccountInitialLoad: () => {} };
const accountSnapshot: CodexAccountsSnapshot = {
  activeId: 'active', profiles: [{
    id: 'active', label: 'Personal', email: 'person@example.com', login: { state: 'signed_in', error: null },
    usage: { state: 'ready', authenticated: true, plan: 'pro', error: null, rateLimits: [{
      limitId: 'codex', limitName: null, plan: 'pro', primary: null,
      secondary: { usedPercent: 6, windowDurationMins: 10_080, resetsAt: null },
    }] },
  }],
};

test('keeps account startup mounted with only the account popover in the status bar', () => {
  let accountReady = 0;
  const tree = harness({ onAccountInitialLoad: () => { accountReady++; } }).render();
  const footerItems = elements(tree).map(element => element.type);
  expect(footerItems).not.toContain('WorkspaceGitBranch');
  expect(elements(tree.props.children)[0]?.type).toBe('AppUpdateIndicator');
  const triggers = elements(tree).filter(element => element.type === 'button');
  const popovers = elements(tree).filter(element => element.props.popover === 'auto');
  expect(triggers).toHaveLength(1);
  expect(popovers).toHaveLength(1);
  expect(new Set(popovers.map(element => element.props.id)).size).toBe(1);
  for (const trigger of triggers) {
    expect(trigger.props['aria-expanded']).toBe(false);
    expect(trigger.props['aria-haspopup']).toBe('dialog');
    expect(trigger.props['aria-controls']).toBe(trigger.props.popoverTarget);
    const panel = popovers.find(element => element.props.id === trigger.props.popoverTarget);
    expect(panel?.props.role).toBe('dialog');
  }
  invoke(find(tree, element => element.type === 'AccountUsagePanel'), 'onInitialLoad');
  expect(accountReady).toBe(1);
  expect(content(tree)).not.toContain('CodeGraph');
});

test('updates summaries from mounted children and reflects native opening and dismissal', () => {
  const app = harness(initialProps);
  const initial = app.render();
  expect(content(initial)).toContain('Account · Checking…');
  const accountPanel = find(initial, element => element.type === 'AccountUsagePanel');
  invoke(accountPanel, 'onStatusChange', accountSnapshot, null);
  const loaded = app.render();
  expect(content(loaded)).toContain('person@example.com');
  expect(content(loaded)).toContain('94%');
  expect(elements(loaded).some(element => element.props['aria-label'] === 'Loading')).toBe(false);
  const popovers = elements(loaded).filter(element => element.props.popover === 'auto');
  for (const panel of popovers) {
    invoke(panel, 'onToggle', { newState: 'open' });
    expect(find(app.render(), element => element.props.popoverTarget === panel.props.id).props['aria-expanded']).toBe(true);
    invoke(panel, 'onToggle', { newState: 'closed' });
    expect(find(app.render(), element => element.props.popoverTarget === panel.props.id).props['aria-expanded']).toBe(false);
  }
  expect(elements(app.render()).filter(element => element.type === 'AccountUsagePanel')).toHaveLength(1);
});

test('surfaces child errors and forwards account selection guards and callbacks', () => {
  const onBeforeSelect = () => null;
  const onSelectionFinished = () => {};
  const reason = 'Finish the active chat before switching accounts.';
  const app = harness({ ...initialProps, selectionDisabledReason: reason, onBeforeSelect, onSelectionFinished });
  const tree = app.render();
  const accountPanel = find(tree, element => element.type === 'AccountUsagePanel');
  expect(accountPanel.props.selectionDisabledReason).toBe(reason);
  expect(accountPanel.props.onBeforeSelect).toBe(onBeforeSelect);
  expect(accountPanel.props.onSelectionFinished).toBe(onSelectionFinished);
  invoke(accountPanel, 'onStatusChange', null, 'Accounts unavailable');
  const failed = app.render();
  const triggers = elements(failed).filter(element => element.type === 'button');
  expect(triggers.every(element => element.props['data-attention'] === true)).toBe(true);
  expect(content(failed)).toContain('Account · Unavailable');
  expect(triggers.find(element => content(element).includes('Account'))?.props.title).toBe('Accounts unavailable');
});

test('shows the active account beside the normalized combined graph and remaining total', () => {
  const app = harness(initialProps);
  const snapshot = structuredClone(accountSnapshot);
  const first = snapshot.profiles[0]!;
  first.usage.rateLimits[0]!.secondary!.usedPercent = 7;
  const second = structuredClone(first);
  second.id = 'second';
  second.email = 'second@example.com';
  second.usage.rateLimits[0]!.secondary!.usedPercent = 0;
  snapshot.profiles.push(second);
  invoke(find(app.render(), element => element.type === 'AccountUsagePanel'), 'onStatusChange', snapshot, null);
  const combined = app.render();
  const trigger = find(combined, element => element.type === 'button' && content(element).includes('193%'));
  expect(content(trigger)).toContain('person@example.com');
  expect(content(trigger)).not.toContain('second@example.com');
  expect(trigger.props['aria-label']).toContain('193% of 200%');
  expect(trigger.props['aria-label']).toContain('2 signed-in accounts');
  expect(find(trigger, element => element.props.style !== undefined).props.style).toEqual({ width: '96.5%' });

  snapshot.activeId = 'second';
  invoke(find(combined, element => element.type === 'AccountUsagePanel'), 'onStatusChange', snapshot, null);
  const switched = find(app.render(), element => element.type === 'button' && content(element).includes('193%'));
  expect(content(switched)).toContain('second@example.com');
  expect(content(switched)).not.toContain('person@example.com');
});

test('does not render a partial total as complete when another signed-in account has missing usage', () => {
  const app = harness(initialProps);
  const snapshot = structuredClone(accountSnapshot);
  const second = structuredClone(snapshot.profiles[0]!);
  second.id = 'second';
  second.usage.rateLimits = [];
  snapshot.profiles.push(second);
  invoke(find(app.render(), element => element.type === 'AccountUsagePanel'), 'onStatusChange', snapshot, null);
  const tree = app.render();
  expect(content(tree)).toContain('Total unavailable');
  expect(content(tree)).not.toContain('%');
  expect(elements(tree).some(element => element.props.style !== undefined)).toBe(false);
});

test('colors the usage indicator by active account readiness independently of popover state', () => {
  const app = harness(initialProps);
  const panel = find(app.render(), element => element.type === 'AccountUsagePanel');
  const state = () => find(app.render(), element => element.props['data-account-state'] !== undefined).props['data-account-state'];
  expect(state()).toBe('disabled');
  invoke(panel, 'onStatusChange', accountSnapshot, null);
  expect(state()).toBe('ready');
  const trigger = find(app.render(), element => element.props['data-account-state'] !== undefined);
  invoke(find(app.render(), element => element.props.id === trigger.props.popoverTarget), 'onToggle', { newState: 'open' });
  expect(state()).toBe('ready');
  const snapshot = structuredClone(accountSnapshot);
  const active = snapshot.profiles[0]!;
  active.login.state = 'signed_out';
  invoke(panel, 'onStatusChange', snapshot, null);
  expect(state()).toBe('disabled');
  active.login.state = 'signed_in';
  active.usage.authenticated = false;
  invoke(panel, 'onStatusChange', snapshot, null);
  expect(state()).toBe('disabled');
  snapshot.activeId = 'missing';
  invoke(panel, 'onStatusChange', snapshot, null);
  expect(state()).toBe('disabled');
  invoke(panel, 'onStatusChange', accountSnapshot, 'Account refresh failed');
  expect(state()).toBe('disabled');
});

test('opens account registration outside the dismissed usage popover and restores trigger focus', () => {
  const app = harness(initialProps);
  expect(elements(app.render()).some(element => element.type === 'AddAccountDialog')).toBe(false);
  invoke(find(app.render(), element => element.type === 'AccountUsagePanel'), 'onAddAccount');
  expect(app.hiddenPopovers).toBe(1);
  const tree = app.render();
  const dialog = find(tree, element => element.type === 'AddAccountDialog');
  const accountPanel = find(tree, element => element.type === 'AccountUsagePanel');
  expect(elements(accountPanel).some(element => element.type === 'AddAccountDialog')).toBe(false);
  let focused = false;
  const trigger = find(tree, element => element.props['data-account-state'] !== undefined);
  const ref = trigger.props.ref as { current: { focus: () => void } | null };
  ref.current = { focus: () => { focused = true; } };
  invoke(dialog, 'restoreFocus');
  expect(focused).toBe(true);
  invoke(dialog, 'onClose');
  expect(elements(app.render()).some(element => element.type === 'AddAccountDialog')).toBe(false);
});
