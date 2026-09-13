import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const ANSI_ESCAPE_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|][^\u0007]*(?:\u0007|\u001B\\))/g;
const IGNORED_IMK_RUN_LOOP_DIAGNOSTIC =
  'error messaging the mach port for IMKCFRunLoopWakeUpReliable';
const IGNORED_CAPS_LOCK_LED_DIAGNOSTIC =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ Electron\[\d+:\d+\] TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit$/;

function isIgnoredMacOSTextInputDiagnostic(line: string): boolean {
  // macOS InputMethodKit can emit this benign framework diagnostic when an
  // Electron text-input session changes focus and its wake-up Mach port is no
  // longer available. It is not a Cheshi failure but obscures actionable
  // stderr. The CapsLock LED diagnostic also occurs during native text input;
  // match its full Electron log format so related errors remain visible.
  const candidate = line.trimEnd();
  return candidate.endsWith(IGNORED_IMK_RUN_LOOP_DIAGNOSTIC)
    || IGNORED_CAPS_LOCK_LED_DIAGNOSTIC.test(candidate);
}

export function forwardDesktopDevOutput(stream: Readable | null, target: Writable): void {
  if (!stream) return;
  stream.setEncoding('utf8');
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on('line', (line) => {
    const output = line.replace(ANSI_ESCAPE_SEQUENCE, '');
    if (!isIgnoredMacOSTextInputDiagnostic(output)) target.write(`${output}\n`);
  });
}
