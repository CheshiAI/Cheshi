import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { forwardDesktopDevOutput } from '../../scripts/forward-desktop-dev-output.mts';

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
