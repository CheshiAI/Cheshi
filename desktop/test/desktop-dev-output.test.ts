import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { forwardDesktopDevOutput } from '../../scripts/forward-desktop-dev-output.mts';
import { launchDevelopmentApp } from '../../scripts/launch-development-app.mts';

async function forwardedOutput(chunks: string[]) {
  const source = new PassThrough();
  let output = '';
  const target = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  forwardDesktopDevOutput(source, target);
  const ended = once(source, 'end');
  for (const chunk of chunks) source.write(chunk);
  source.end();
  await ended;
  return output;
}

test('filters known native input diagnostics across chunks and preserves app errors', async () => {
  const output = await forwardedOutput([
    '[cheshi] Vite ready\n2026-09-13 01:35:24.749 Electron[87068:1524608] TSM AdjustCapsLockLEDForKeyTransition',
    'Handling - _ISSetPhysicalKeyboardCapsLockLED Inhibit\r\n',
    '2026-08-24 Electron[1:2] error messaging the mach port for IMKCFRunLoopWakeUpReliable\n',
    '[cheshi] Renderer process exited: reason=crashed exitCode=5\n',
    "Error occurred in handler for 'cheshi:delete-codex-chat-session': Error [CodexRequestRejectedError]: forked history still references it\n",
    '    at responseError (codex-app-server-client.mts:37:17)\n',
  ]);

  assert.equal(output, [
    '[cheshi] Vite ready',
    '[cheshi] Renderer process exited: reason=crashed exitCode=5',
    "Error occurred in handler for 'cheshi:delete-codex-chat-session': Error [CodexRequestRejectedError]: forked history still references it",
    '    at responseError (codex-app-server-client.mts:37:17)',
    '',
  ].join('\n'));
});

test('preserves similar but actionable output', async () => {
  const lines = [
    'error messaging the mach port for IMKCFRunLoopWakeUpReliable: repeated failure',
    'TSM AdjustCapsLockLEDForKeyTransitionHandling failed',
    '2026-09-13 01:35:24.749 Electron[87068:1524608] TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit: failed',
    '2026-09-13 01:35:24.749 Electron[87068:1524608] Error: TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit',
    '2026-09-13 01:35:24.749 other-process[87068:1524608] TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit',
    'TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit',
  ];
  const output = await forwardedOutput(lines.map((line) => `${line}\n`));

  assert.equal(output, `${lines.join('\n')}\n`);
});

test('filters ANSI-wrapped CapsLock diagnostics without a final newline', async () => {
  const output = await forwardedOutput([
    '\u001b[33m2026-09-13 01:35:24.749 Electron[87068:1524608] TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit\u001b[0m',
  ]);

  assert.equal(output, '');
});

test('preserves a final error without a newline after a filtered diagnostic', async () => {
  const output = await forwardedOutput([
    '2026-09-13 01:35:24.749 Electron[87068:1524608] TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit\n',
    '\u001b[31mError: keyboard input failed\u001b[0m',
  ]);

  assert.equal(output, 'Error: keyboard input failed\n');
});

test('Launch Services inherits private environment and drains app logs before completing', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-launch-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  let output = '';
  let errors = '';
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const stderr = new Writable({ write(chunk, _encoding, done) { errors += chunk.toString(); done(); } });
  const fakeSpawn = ((executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; detached: boolean }) => {
    assert.equal(executable, '/usr/bin/open');
    assert.deepEqual(args.slice(0, 4), ['-n', '-W', '-a', '/checkout/Cheshi Development.app']);
    assert.deepEqual(args.slice(-2), ['--args', '/checkout']);
    assert.equal(args.includes('test-private-value'), false);
    assert.equal(options.env.TEST_TOKEN, 'test-private-value');
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(options.env.CHESHI_DEV_LAUNCH_SERVICES, '1');
    assert.equal(options.detached, true);
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  const launched = launchDevelopmentApp({ bundle: '/checkout/Cheshi Development.app', root: '/checkout',
    directory, env: { TEST_TOKEN: 'test-private-value', ELECTRON_RUN_AS_NODE: '1' }, stdout, stderr }, fakeSpawn);
  assert.equal(statSync(path.join(directory, 'stdout.log')).mode & 0o777, 0o600);
  appendFileSync(path.join(directory, 'stdout.log'), '앱 로그\n');
  appendFileSync(path.join(directory, 'stderr.log'), '\u001b[31mfinal error without newline\u001b[0m');
  child.emit('close', 0, null);
  assert.deepEqual(await launched.completion, { code: 0, signal: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(output, '앱 로그\n');
  assert.equal(errors, 'final error without newline\n');
});
