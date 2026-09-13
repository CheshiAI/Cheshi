import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop.ts';
import type { GitWorkspaceController } from '../frontend/src/features/git/useGitWorkspaceController.ts';

interface HookSlot {
  value?: unknown;
  dependencies?: readonly unknown[];
  cleanup?: () => void;
}

function sameDependencies(previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
  return previous?.length === next.length && next.every((value, index) => Object.is(value, previous[index]));
}

function loadModule(filename: string, modules: Record<string, unknown>): Record<string, unknown> {
  const source = readFileSync(new URL(`../frontend/src/features/git/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected controller dependency: ${name}`);
      return modules[name];
    },
    performance,
    setTimeout,
    window: { addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  });
  return exports;
}

// Keep render and passive effects separate so tests can observe the frame between them.
export function createGitWorkspaceControllerHarness(desktop: Partial<CheshiDesktopApi>) {
  const slots: HookSlot[] = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  const nextSlot = (): HookSlot => {
    const index = cursor++;
    return slots[index] ??= {};
  };
  const react = {
    useState(initial: unknown) {
      const slot = nextSlot();
      if (!Object.hasOwn(slot, 'value')) slot.value = typeof initial === 'function' ? initial() : initial;
      return [slot.value, (next: unknown) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }];
    },
    useRef(initial: unknown) {
      const slot = nextSlot();
      return slot.value ??= { current: initial };
    },
    useCallback(callback: unknown, dependencies: readonly unknown[]) {
      const slot = nextSlot();
      if (!sameDependencies(slot.dependencies, dependencies)) {
        slot.value = callback;
        slot.dependencies = dependencies;
      }
      return slot.value;
    },
    useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
      const slot = nextSlot();
      if (sameDependencies(slot.dependencies, dependencies)) return;
      slot.dependencies = dependencies;
      effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() ?? undefined;
      });
    },
  };
  const branchHistory = { refresh() {} };
  const modules: Record<string, unknown> = {
    react,
    '../../cheshiDesktop': { cheshiDesktop: desktop },
    '../../shared/errorMessage': { errorMessage: (error: Error) => error.message },
    './gitBranchCheckout': {},
    './useGitBranchHistory': { useGitBranchHistory: () => branchHistory },
    './gitWorkspaceModel': loadModule('gitWorkspaceModel.ts', {}),
    './unifiedDiff': loadModule('unifiedDiff.ts', {}),
  };
  modules['./gitRepositoryRefresh'] = loadModule('gitRepositoryRefresh.ts', modules);
  modules['./useGitPullRequestCommitDiff'] = loadModule('useGitPullRequestCommitDiff.ts', modules);
  const module = loadModule('useGitWorkspaceController.ts', modules);
  const hook = module.useGitWorkspaceController;
  assert.ok(typeof hook === 'function');
  return {
    render(): GitWorkspaceController {
      cursor = 0;
      return hook() as GitWorkspaceController;
    },
    flushEffects(): void {
      for (const effect of effects.splice(0)) effect();
    },
    dispose(): void {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}
