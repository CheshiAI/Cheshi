import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { build, createLogger } from 'vite';
import { browserDependencies } from '../frontend/open-pencil/browser-dependencies';
import { normalizeEagerImports } from '../frontend/open-pencil/eager-imports';

test('browser dependencies bundle without warnings and run with string code generation disabled', async () => {
  const warnings: string[] = [];
  const logger = createLogger('warn');
  const entry = '\0browser-dependencies-test';
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'warn',
    customLogger: { ...logger, warn(message, options) { warnings.push(message); logger.warn(message, options); } },
    plugins: [browserDependencies(), {
      name: 'dependency-test-entry',
      resolveId(id) { return id === entry ? id : null; },
      load(id) {
        return id === entry ? `
import { Circle } from 'lucide-react';
import { createElement } from 'react';
export { CSSStyleSheet, parse } from '@acemir/cssom';
export { z } from 'zod';
export const icon = createElement(Circle);
` : null;
      },
    }],
    build: { write: false, target: 'esnext', minify: true,
      rollupOptions: { input: entry, preserveEntrySignatures: 'strict',
        output: { format: 'iife', name: 'dependencies' } } },
  });
  expect(warnings).toEqual([]);
  if (!('output' in result)) throw new Error('Expected one bundle');
  const chunk = result.output.find(item => item.type === 'chunk');
  if (!chunk) throw new Error('Missing dependency test bundle');
  const dependencies = runInNewContext(`${chunk.code}; dependencies`, { DOMException }, {
    contextCodeGeneration: { strings: false, wasm: false },
  }) as {
    parse(css: string): { cssRules: { cssText: string }[] };
    CSSStyleSheet: new () => { deleteRule(index: number): void; __globalObject?: { DOMException: typeof Error } };
    z: typeof import('zod').z;
    icon: { type: unknown };
  };
  expect(dependencies.icon.type).toBeDefined();
  const schema = dependencies.z.object({ count: dependencies.z.number().int() });
  expect(schema.safeParse({ count: 2 }).success).toBe(true);
  expect(schema.safeParse({ count: '2' }).success).toBe(false);
  expect(dependencies.parse('a { color: red }').cssRules[0]?.cssText).toContain('color: red');
  const sheet = new dependencies.CSSStyleSheet();
  expect(() => sheet.deleteRule(0)).toThrow(DOMException);
  // CSSOM must still prefer the owning document's realm over the global realm.
  sheet.__globalObject = { DOMException: RangeError };
  expect(() => sheet.deleteRule(0)).toThrow(RangeError);
}, 30000);

test('eager module adaptation preserves async calls and live bindings through a cycle', async () => {
  const settings = '\0/vendor/open-pencil/src/app/diagnostics/settings.ts';
  const recorder = '\0/vendor/open-pencil/src/app/diagnostics/recorder.ts';
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'warn',
    plugins: [{
      name: 'eager-import-cycle',
      resolveId(id) { return id === settings ? id : id === './recorder' ? recorder : id === './settings' ? settings : null; },
      load(id) {
        if (id === settings) return normalizeEagerImports(`
export function initial() { return 1; }
export async function read() { const { diagnostics } = await import('./recorder'); return diagnostics; }
export async function change() { const { increment } = await import('./recorder'); increment(); }
`, id);
        if (id === recorder) return `
import { initial } from './settings';
export let diagnostics = initial();
export function increment() { diagnostics++; }
`;
        return null;
      },
    }],
    build: { write: false, minify: true, rollupOptions: { input: settings,
      preserveEntrySignatures: 'strict', output: { format: 'iife', name: 'settings' } } },
  });
  if (!('output' in result)) throw new Error('Expected one bundle');
  const chunk = result.output.find(item => item.type === 'chunk');
  if (!chunk) throw new Error('Missing cycle test bundle');
  const settingsModule = runInNewContext(`${chunk.code}; settings`) as {
    read(): Promise<number>; change(): Promise<void>;
  };
  expect(await settingsModule.read()).toBe(1);
  await settingsModule.change();
  expect(await settingsModule.read()).toBe(2);
});
