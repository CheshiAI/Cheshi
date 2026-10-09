import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'bun:test';
import { AgentPlatform } from '../lib/agent-platform/service.mts';
import { git } from '../lib/agent-platform/git-workspaces.mts';
import type { ExecutionPlan, ExecutionReceipt, ExecutionRequest, PlatformExecutor, TaskInput } from '../lib/agent-platform/contracts.mts';

export const plan: ExecutionPlan = { image: `sha256:${'a'.repeat(64)}`, command: ['fixture'], timeoutMs: 10_000, cpus: 1, memoryMb: 64 };
export function taskInput(id: string, scope = [`${id}.txt`], dependencies: string[] = []): TaskInput {
  return { id, assignee: `agent-${id}`, goal: `Implement ${id}`, reason: `Requested behavior ${id}`, criteria: [`${id} works`], scope, dependencies, execution: { ...plan, command: [id] } };
}
export function receipt(request: ExecutionRequest, exitCode = 0, output = ''): ExecutionReceipt {
  return { id: request.id, image: request.image, exitCode, output, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
}
export function executor(execute: PlatformExecutor['execute']): PlatformExecutor {
  return { identity: 'test:fixture', execute, inspect: async () => 'missing' };
}
export async function fixture(execution: PlatformExecutor, maxConcurrent = 4) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-agent-platform-')));
  const repository = join(root, 'source'), directory = join(root, 'platform');
  mkdirSync(repository);
  await git(repository, ['init', '-b', 'main']);
  writeFileSync(join(repository, 'shared.txt'), 'baseline\n');
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', '[init] set up fixture']);
  const options = { repository, directory, baseRef: 'refs/heads/main', maxConcurrent, executor: execution };
  const platform = await AgentPlatform.open(options);
  return { root, repository, directory, platform, options, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
export async function assertFailure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  try { await operation; } catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(pattern); return; }
  throw new Error('Expected operation to fail.');
}
export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
