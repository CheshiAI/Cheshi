import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { NotesSearchStatus } from '../frontend/src/features/notes/NotesSearchStatus';
import type { NotesSearchStatus as SearchStatus } from '../shared/apple-notes-search';

function harness(read: () => Promise<SearchStatus>) {
  let state: SearchStatus | null = null;
  let cleanup: (() => void) | undefined;
  let mounted = false;
  const timers = new Set<() => void>();
  const modules: Record<string, unknown> = {
    react: {
      useState: () => [state, (value: SearchStatus | null) => { state = value; }],
      useEffect: (effect: () => () => void) => { if (!mounted) { mounted = true; cleanup = effect(); } },
    },
    'react/jsx-runtime': jsx,
    '../../cheshiDesktop': { cheshiDesktop: { appleNotes: { searchStatus: read } } },
    './NotesSearchStatus.module.css': { default: { status: 'description-status' } },
  };
  const exports: { NotesSearchStatus?: typeof NotesSearchStatus } = {};
  const source = readFileSync(new URL('../frontend/src/features/notes/NotesSearchStatus.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } }).outputText, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, setTimeout: (callback: () => void) => { timers.add(callback); return callback; },
  clearTimeout: (callback: () => void) => timers.delete(callback) });
  return { render: () => renderToStaticMarkup(exports.NotesSearchStatus!()),
    tick: () => { const callbacks = [...timers]; timers.clear(); callbacks.forEach(callback => callback()); },
    close: () => cleanup?.(), timers };
}

test('footer shows progress, hides completed work and observes later background updates', async () => {
  let status: SearchStatus = { state: 'building', completed: 19, pending: 102, error: null };
  const app = harness(async () => status);
  expect(app.render()).toBe(''); await Promise.resolve();
  expect(app.render()).toContain('Preparing note search… 19/102');
  status = { ...status, state: 'ready', completed: 102 }; app.tick(); await Promise.resolve();
  expect(app.render()).toBe('');
  status = { ...status, state: 'updating', completed: 1 }; app.tick(); await Promise.resolve();
  expect(app.render()).toContain('Updating note search… 1/102');
  app.close(); expect(app.timers.size).toBe(0);
});

test('late status replies after unmount cannot restore text or polling', async () => {
  let resolve!: (value: SearchStatus) => void;
  const pending = new Promise<SearchStatus>(done => { resolve = done; });
  const app = harness(() => pending);
  app.render(); app.close();
  resolve({ state: 'building', completed: 1, pending: 10, error: null }); await Promise.resolve();
  expect(app.render()).toBe(''); expect(app.timers.size).toBe(0);
});

test('status errors hide stale progress and polling can recover', async () => {
  let failing = true;
  const app = harness(async () => {
    if (failing) throw new Error('Disconnected');
    return { state: 'building', completed: 1, pending: 10, error: null };
  });
  app.render(); await Promise.resolve(); expect(app.render()).toBe('');
  failing = false; app.tick(); await Promise.resolve();
  expect(app.render()).toContain('Preparing note search'); app.close();
});
