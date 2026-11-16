import { spawn } from 'node:child_process';
import { parseIMessageRecipient } from '../shared/imessage-notifications.ts';

function appleScriptString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
}
export function iMessageScript(recipient: string, text: string): string {
  parseIMessageRecipient(recipient);
  if (!text.trim() || text.length > 2000 || text.includes('\0')) throw new TypeError('Invalid notification text.');
  return `set targetHandle to ${appleScriptString(recipient)}
set notificationText to ${appleScriptString(text)}
try
  tell application "/System/Applications/Messages.app"
    set candidates to every account whose service type is iMessage and enabled is true
    if (count of candidates) is 0 then return "no-account"
    set destination to participant targetHandle of (item 1 of candidates)
    send notificationText to destination
  end tell
  return "submitted"
on error errorText number errorNumber
  if errorNumber is -1743 then return "permission-denied"
  return "failed:" & (errorNumber as text)
end try`;
}

function submissionError(status: string, diagnostics: string, code: number | null): Error {
  if (status === 'permission-denied') return new Error('Allow Cheshi to control Messages in System Settings → Privacy & Security → Automation.');
  if (status === 'no-account') return new Error('Sign in to iMessage in the Mac Messages app first.');
  if (code !== 0 && /(?:syntax|compilation) error:/i.test(diagnostics)) {
    return new Error('Messages automation could not compile. No message was sent. Restart Cheshi after updating.');
  }
  const errorNumber = /^failed:(-?\d{1,9})$/.exec(status)?.[1];
  return new Error(errorNumber
    ? `Messages rejected the notification (AppleScript error ${errorNumber}). Check Messages; no automatic retry.`
    : 'Messages could not confirm submission. Check Messages; no automatic retry.');
}
/** Submit through Messages; this is not a delivery/read receipt. Never retry an uncertain send. */
export function sendIMessage(recipient: string, text: string, signal: AbortSignal, options: {
  spawnProcess?: typeof spawn; timeoutMs?: number;
} = {}): Promise<void> {
  const source = iMessageScript(recipient, text);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostics = '', settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve();
    };
    const aborted = () => finish(new Error('Notification cancelled. Messages may already have accepted it.'));
    const timer = setTimeout(() => finish(new Error('Messages did not respond in time. Delivery is unknown; no automatic retry.')), options.timeoutMs ?? 30_000);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 4096) finish(new Error('Invalid response from Messages.'));
    });
    // Inspect bounded diagnostics only for error classification; never expose or log their private contents.
    child.stderr?.on('data', (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString('utf8')).slice(0, 4096);
    });
    child.stdin?.on('error', () => finish(new Error('Could not communicate with Messages.')));
    child.once('error', () => finish(new Error('Could not start Messages automation.')));
    child.once('close', code => {
      const status = output.trim();
      if (code === 0 && status === 'submitted') { finish(); return; }
      finish(submissionError(status, diagnostics, code));
    });
    child.stdin?.end(source);
  });
}
