import { test, expect } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { measuredHostCall } from '../../experiments/codex-specialists/src/tool-evidence';

test('host calls persist reusable receipts and measure failures without recording arguments', async () => {
  const task = randomUUID(), directory = join(tmpdir(), 'homie-runs', task);
  try {
    const output = await measuredHostCall(task, 'homie_fixture', 'capture', async () => ({
      result: { ok: true, transport: { token: 'private-fixture' } }, artifacts: [],
    }));
    expect(dirname(output.receiptPath as string)).toBe(directory);
    expect(JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'))).toEqual(output);
    await measuredHostCall(task, 'homie_fixture', 'tap', async () => ({
      result: { ok: false, error: { code: 'geometry_changed', message: 'Capture again' } },
    }));
    let failed = false;
    try { await measuredHostCall(task, 'homie_fixture', 'capture', async () => { throw new Error('Connection closed'); }); }
    catch { failed = true; }
    expect(failed).toBe(true);
    const ledger = await readFile(join(directory, 'calls.jsonl'), 'utf8');
    expect(ledger).not.toContain('private-fixture');
    const calls = ledger.trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.status)).toEqual(['returned', 'failed', 'transport-failed']);
    expect(calls[1].failureCode).toBe('geometry_changed');
    expect(calls.every(call => call.durationMs >= 0)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
