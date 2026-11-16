import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodexUpdateReporter, CodexUpdateStage } from '../../shared/codex-update.ts';
import type { DockerCommand } from './docker.mts';

/** Progress belongs to one update operation, never unrelated worker traffic. */
export function createCodexUpdateProgress(execute: DockerCommand) {
  const scope = new AsyncLocalStorage<CodexUpdateReporter | undefined>();
  const run: DockerCommand = async (args, input) => {
    const report = scope.getStore();
    // Only a signal leaves this boundary; command output may contain private data.
    const result = await execute(args, input, report ? () => report() : undefined);
    report?.();
    return result;
  };
  return {
    run,
    stage: (stage: CodexUpdateStage) => scope.getStore()?.(stage),
    track: <T,>(report: CodexUpdateReporter | undefined, action: () => Promise<T>) => scope.run(report, action),
  };
}
