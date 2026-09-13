import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { ALICE_THINKING_QUOTES } from '../frontend/src/shared/ui/loadingThinkingQuotes.ts';

interface TestElement {
  type: string;
  props: Record<string, unknown>;
}

const source = readFileSync(new URL('../frontend/src/shared/ui/LoadingState.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function isElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'props' in value
    && typeof value.props === 'object' && value.props !== null;
}

function createLoadingHarness() {
  let now = 10_000;
  const states: unknown[] = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let nextIntervalId = 0;
  const effects: { dependencies: unknown[]; cleanup?: () => void }[] = [];
  let pendingEffects: (() => void)[] = [];
  const intervals = new Map<number, { callback: () => void; delay: number; nextAt: number }>();
  const jsx = (type: string, props: Record<string, unknown>): TestElement => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = stateIndex++;
        if (index >= states.length) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], (value: unknown) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        }];
      },
      useEffect(callback: () => (() => void) | undefined, dependencies: unknown[]) {
        const index = effectIndex++;
        const previous = effects[index];
        if (previous && previous.dependencies.length === dependencies.length
          && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return;
        pendingEffects.push(() => {
          previous?.cleanup?.();
          effects[index] = { dependencies, cleanup: callback() };
        });
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './LoadingState.module.css': { default: new Proxy({}, { get: (_target, name) => String(name) }) },
    './loadingThinkingQuotes': { ALICE_THINKING_QUOTES },
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected loading dependency: ${name}`);
      return modules[name];
    },
    performance: { now: () => now },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    window: {
      setInterval(callback: () => void, delay: number) {
        const id = ++nextIntervalId;
        intervals.set(id, { callback, delay, nextAt: now + delay });
        return id;
      },
      clearInterval(id: number) { intervals.delete(id); },
    },
  });
  const component = exports.LoadingState;
  assert.ok(typeof component === 'function');

  return {
    render(props: Record<string, unknown> = {}) {
      stateIndex = 0;
      effectIndex = 0;
      const tree: unknown = component(props);
      assert.ok(isElement(tree));
      for (const effect of pendingEffects) effect();
      pendingEffects = [];
      return tree;
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const interval of intervals.values()) {
        if (interval.nextAt > now) continue;
        interval.callback();
        interval.nextAt += (Math.floor((now - interval.nextAt) / interval.delay) + 1) * interval.delay;
      }
    },
    pendingIntervals: () => intervals.size,
    dispose() {
      for (const effect of effects) effect.cleanup?.();
      effects.length = 0;
    },
  };
}

function elapsedText(tree: TestElement): unknown {
  const children = tree.props.children;
  assert.ok(Array.isArray(children));
  const elapsed = children.find((child: unknown) => isElement(child) && child.props.className === 'elapsed');
  assert.ok(isElement(elapsed));
  return elapsed.props.children;
}

function announcedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(announcedText).join(' ').trim();
  if (!isElement(value) || value.props['aria-hidden'] === 'true') return '';
  if (typeof value.props['aria-label'] === 'string') return value.props['aria-label'];
  return announcedText(value.props.children);
}

test('elapsed time catches up after delayed callbacks and crosses the minute boundary', (t) => {
  const loader = createLoadingHarness();
  t.after(() => loader.dispose());
  assert.equal(elapsedText(loader.render()), '0.0s');
  loader.advance(1_900);
  assert.equal(elapsedText(loader.render()), '1.9s');
  loader.advance(58_099);
  assert.equal(elapsedText(loader.render()), '59.9s');
  loader.advance(1);
  assert.equal(elapsedText(loader.render()), '1m 0.0s');
  loader.advance(1_900);
  assert.equal(elapsedText(loader.render()), '1m 1.9s');
});

test('unmount releases the timer and a new loading session starts at zero', (t) => {
  const loader = createLoadingHarness();
  t.after(() => loader.dispose());
  loader.render();
  loader.advance(7_000);
  assert.equal(elapsedText(loader.render()), '7.0s');
  assert.equal(loader.pendingIntervals(), 1);
  loader.dispose();
  assert.equal(loader.pendingIntervals(), 0);

  const next = createLoadingHarness();
  t.after(() => next.dispose());
  assert.equal(elapsedText(next.render()), '0.0s');
  assert.equal(next.pendingIntervals(), 1);
});

test('operation labels describe preparation without replacing the shared elapsed timer', (t) => {
  const loader = createLoadingHarness();
  t.after(() => loader.dispose());
  const initial = loader.render({ type: 'preparing', label: 'Opening conversation…' });
  assert.equal(announcedText(initial), 'Opening conversation…');
  loader.advance(2_500);
  const updated = loader.render({ type: 'processing', label: 'Creating fork…' });
  assert.equal(announcedText(updated), 'Creating fork…');
  assert.equal(elapsedText(updated), '2.5s');
  assert.equal(loader.pendingIntervals(), 1);
});

test('loading types update the live status without restarting the elapsed timer', (t) => {
  const loader = createLoadingHarness();
  t.after(() => loader.dispose());
  const initial = loader.render();
  assert.equal(initial.props.role, 'status');
  assert.equal(announcedText(initial), 'Preparing...');
  loader.advance(12_300);
  const updated = loader.render();
  assert.equal(elapsedText(updated), '12.3s');
  assert.equal(announcedText(updated), 'Preparing...');

  const working = loader.render({ type: 'working' });
  assert.equal(announcedText(working), 'Working...');
  assert.equal(elapsedText(working), '12.3s');
  loader.advance(1_200);

  const processing = loader.render({ type: 'processing' });
  assert.equal(announcedText(processing), 'Processing...');
  assert.equal(elapsedText(processing), '13.5s');

  const thinking = loader.render({ type: 'thinking' });
  assert.equal(announcedText(thinking), 'Thinking...');
  assert.equal(elapsedText(thinking), '13.5s');

  const preparing = loader.render({ type: 'preparing' });
  assert.equal(announcedText(preparing), 'Preparing...');
  assert.equal(elapsedText(preparing), '13.5s');
  assert.equal(loader.pendingIntervals(), 1);
});

function quoteText(tree: TestElement): string {
  const children = tree.props.children;
  assert.ok(Array.isArray(children));
  const quote = children.find((child: unknown) => isElement(child) && child.props.lang === 'en');
  assert.ok(isElement(quote));
  assert.equal(quote.props['aria-hidden'], 'true');
  assert.equal(typeof quote.props.children, 'string');
  return quote.props.children as string;
}

test('the quote dictionary contains one hundred unique attributed English excerpts', () => {
  assert.equal(ALICE_THINKING_QUOTES.length, 100);
  assert.equal(new Set(ALICE_THINKING_QUOTES.map(quote => quote.id)).size, 100);
  assert.equal(new Set(ALICE_THINKING_QUOTES.map(quote => quote.text)).size, 100);
  for (const quote of ALICE_THINKING_QUOTES) {
    assert.ok(quote.text.trim());
    assert.ok(quote.speaker.trim());
    assert.ok(Number.isInteger(quote.chapter) && quote.chapter >= 1 && quote.chapter <= 12);
    assert.doesNotMatch(quote.text, /[가-힣]/u);
  }
});

test('thinking rotates quotes every six seconds independently of the elapsed timer', (t) => {
  const loader = createLoadingHarness();
  t.after(() => loader.dispose());
  const first = quoteText(loader.render({ type: 'thinking' }));
  assert.equal(loader.pendingIntervals(), 2);
  loader.advance(100);
  assert.equal(quoteText(loader.render({ type: 'thinking' })), first);
  loader.advance(5_900);
  const second = loader.render({ type: 'thinking' });
  assert.notEqual(quoteText(second), first);
  assert.equal(elapsedText(second), '6.0s');
  assert.equal(announcedText(second), 'Thinking...');
  const seen = new Set([first, quoteText(second)]);
  let previous = quoteText(second);
  for (let index = 0; index < 98; index++) {
    loader.advance(6_000);
    const current = quoteText(loader.render({ type: 'thinking' }));
    assert.notEqual(current, previous);
    seen.add(current);
    previous = current;
  }
  assert.equal(seen.size, 100);
  loader.render({ type: 'working' });
  assert.equal(loader.pendingIntervals(), 1);
  loader.dispose();
  assert.equal(loader.pendingIntervals(), 0);
});
