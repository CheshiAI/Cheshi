import { mkdir, writeFile, appendFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { JsonRecord } from './protocol.ts';

/** Private receipts preserve opaque host state; the separate ledger contains no arguments. */
export async function measuredHostCall(taskId: string, tool: string, action: string | null,
  operation: () => Promise<JsonRecord>, root = join(tmpdir(), 'homie-runs')): Promise<JsonRecord> {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('Invalid evidence task identity.');
  const directory = join(root, taskId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), startedAt = new Date().toISOString(), start = performance.now();
  let output: JsonRecord | undefined, failure: unknown, failed = false;
  try { output = await operation(); } catch (error) { failure = error; failed = true; }
  const data = output?.result as JsonRecord | undefined;
  const error = data?.error as JsonRecord | undefined;
  const toolFailed = output?.isError === true || data?.ok === false;
  const stoppedReason = typeof data?.stoppedReason === 'string' ? data.stoppedReason : null;
  const measurement = {
    id, tool, action, startedAt, endedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    status: failed ? 'transport-failed' : toolFailed ? 'failed' : 'returned',
    failureCode: failed ? 'tool_exchange_failed' : typeof error?.code === 'string' ? error.code : stoppedReason ?? (toolFailed ? 'tool_returned_error' : null),
    failureReason: failed ? (failure instanceof Error ? failure.message : 'Tool exchange failed')
      : typeof error?.message === 'string' ? error.message : toolFailed ? stoppedReason ?? 'Tool returned an error; inspect its private receipt.' : null,
  };
  await appendFile(join(directory, 'calls.jsonl'), JSON.stringify(measurement) + '\n', { mode: 0o600 });
  if (output) {
    output.measurement = measurement;
    output.measurementPath = join(directory, 'calls.jsonl');
    output.receiptPath = join(directory, `${id}.json`);
    await writeFile(output.receiptPath as string, JSON.stringify(output), { flag: 'wx', mode: 0o600 });
    const temporary = join(directory, `${id}.latest`);
    await writeFile(temporary, JSON.stringify(output), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'latest.json'));
  }
  if (failed) throw failure;
  return output!;
}
