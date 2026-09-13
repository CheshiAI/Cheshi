import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import * as icons from 'lucide-react';
import type { ComponentProps, ReactElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { NeumorphicButton } from '../frontend/src/shared/ui';
import { AccountProfileUsage } from '../frontend/src/features/account/AccountProfileUsage';
import type { AccountUsagePanel } from '../frontend/src/features/account/AccountUsagePanel';
import * as accountsModel from '../frontend/src/features/account/accountsModel';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts';

const snapshot: CodexAccountsSnapshot = {
  activeId: 'a',
  profiles: ['a', 'b'].map(id => ({
    id, label: id, email: `${id}@example.com`,
    usage: { state: 'ready', authenticated: true, plan: 'pro', error: null,
      rateLimits: [{ limitId: 'codex', limitName: null, plan: 'pro', primary: null,
        secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_800_000_000 } }] },
    login: { state: 'signed_in', error: null },
  })),
};
const reason = 'Finish the active chat operation before switching accounts.';

// Seed a loaded account snapshot while rendering the real panel and profile controls.
function harness() {
  const states: unknown[] = [snapshot, false, true, null];
  let cursor = 0;
  let selections = 0;
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (index >= states.length) states[index] = initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
      useRef: (current: unknown) => ({ current }),
      useEffect: () => {},
      useCallback: (callback: unknown) => callback,
    },
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': icons,
    '../../shared/ui': { NeumorphicButton },
    '../../cheshiDesktop': { cheshiDesktop: { codexAccounts: {
      select: async () => { selections++; return snapshot; },
    } } },
    './AccountProfileUsage': { AccountProfileUsage },
    './accountsModel': accountsModel,
    './AccountUsagePanel.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/account/AccountUsagePanel.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.AccountUsagePanel;
  assert.ok(typeof component === 'function');
  return {
    render(props: ComponentProps<typeof AccountUsagePanel> = {}): ReactElement {
      cursor = 0;
      return component(props);
    },
    get selections() { return selections; },
  };
}

function button(html: string, label: string, index = 0): string {
  const matches = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.filter(value => value.includes(`aria-label="${label}"`));
  assert.ok(matches?.[index], `Expected ${label} button`);
  return matches[index];
}

test('configuration guards preserve account panel content and structure while locking affected controls', () => {
  const app = harness();
  const idle = renderToStaticMarkup(app.render());
  const locked = renderToStaticMarkup(app.render({ selectionDisabledReason: reason }));
  expect(locked.replace(/<[^>]+>/g, '')).toBe(idle.replace(/<[^>]+>/g, ''));
  expect(locked.match(/<\/?[a-z][a-z0-9-]*/g)).toEqual(idle.match(/<\/?[a-z][a-z0-9-]*/g));
  expect(button(idle, 'Use account')).not.toContain('disabled');
  expect(button(locked, 'Use account')).toContain('disabled');
  expect(button(locked, 'Use account')).toContain(`title="${reason}"`);
  expect(button(locked, 'Log out')).toContain('disabled');
  expect(button(locked, 'Log out')).toContain(`title="${reason}"`);
  expect(button(locked, 'Log out', 1)).not.toContain('disabled');
  expect(renderToStaticMarkup(app.render())).toBe(idle);
});

test('a guarded selection still rejects the action and reports its error', () => {
  const app = harness();
  const tree = app.render({ selectionDisabledReason: reason });
  const children = (tree.props as { children: unknown[] }).children;
  const profiles = children.flat().filter((child): child is ReactElement<ComponentProps<typeof AccountProfileUsage>> =>
    typeof child === 'object' && child !== null && 'type' in child && child.type === AccountProfileUsage);
  const inactive = profiles.find(profile => !profile.props.active);
  assert.ok(inactive);
  inactive.props.onSelect();
  expect(app.selections).toBe(0);
  const html = renderToStaticMarkup(app.render({ selectionDisabledReason: reason }));
  expect(html).toContain(`role="alert">${reason}</p>`);
});

test('the add action opens its dialog without creating another inline profile', () => {
  const app = harness();
  let opened = 0;
  const tree = app.render({ onAddAccount: () => { opened++; } });
  const children = (tree.props as { children: ReactElement[] }).children;
  const header = children[0]!;
  const actions = (header.props as { children: ReactElement[] }).children[1]!;
  const addButton = (actions.props as { children: ReactElement[] }).children[0]!;
  const props = addButton.props as ComponentProps<typeof NeumorphicButton>;
  expect(props['aria-label']).toBe('Add Codex account');
  expect(props.disabled).toBe(false);
  const onClick = props.onClick;
  assert.ok(onClick);
  // The callback does not consume a pointer event; keyboard activation uses the same action.
  (onClick as () => void)();
  expect(opened).toBe(1);
  expect(renderToStaticMarkup(app.render())).not.toContain('Account 3');
});
