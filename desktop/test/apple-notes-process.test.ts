import { expect, test } from 'bun:test';
import { runAppleNotesScript } from '../lib/apple-notes-process.mts';
import { appleNotesScript } from '../lib/apple-notes-script.mts';

async function expectProcessFailure(operation: Promise<string>, reason: string) {
  try { await operation; }
  catch (error) { expect(error).toMatchObject({ reason }); return; }
  throw new Error('Expected automation to fail.');
}

test.skipIf(process.platform !== 'darwin')('runs stdin through native JXA with a fake target and no access to personal Notes', async () => {
  // JXA reserves Application and does not allow it to be shadowed. Replace its
  // one call site with a differently named fake before invoking the interpreter.
  const stub = String.raw`function fakeNotesApplication(id) {
    if (id !== 'com.apple.Notes') throw new Error('Unexpected application');
    return { accounts: function () { return []; } };
  }`;
  const program = appleNotesScript({ action: 'folders' }).replace("Application('com.apple.Notes')", "fakeNotesApplication('com.apple.Notes')");
  expect(program).not.toMatch(/\bApplication\s*\(/);
  const script = `${stub}\n${program}`;
  expect(JSON.parse(await runAppleNotesScript(script))).toEqual({ ok: true, value: [] });
});

test.skipIf(process.platform !== 'darwin')('limits native automation execution time and output size', async () => {
  await expectProcessFailure(runAppleNotesScript('while (true) {}', { timeoutMs: 150 }), 'timeout');
  await expectProcessFailure(runAppleNotesScript('"x".repeat(10000);', { maxOutputBytes: 100 }), 'output');
});
