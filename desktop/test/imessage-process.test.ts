import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, type spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { iMessageScript, sendIMessage } from '../lib/imessage-process.mts';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true; } });
  let script = ''; child.stdin.on('data', chunk => { script += chunk.toString(); });
  const calls: unknown[] = [];
  const spawnProcess = ((...args: unknown[]) => { calls.push(args); return child; }) as unknown as typeof spawn;
  return { child, calls, spawnProcess, script: () => script };
}
async function failure(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try { await promise; } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error); expect(String(error)).toMatch(pattern);
  return String(error);
}

test('recipient and message values remain string data and scripts target only iMessage accounts', async () => {
  const f = fixture();
  const promise = sendIMessage('+821012345678', 'quote " & do shell script "bad"\nbackslash \\', new AbortController().signal, f);
  expect(f.script()).toContain('service type is iMessage and enabled is true');
  expect(f.script()).toContain('quote \\" & do shell script \\"bad\\"\\nbackslash \\\\');
  expect(f.calls[0]).toEqual(['/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] }]);
  f.child.stdout.end('submitted\n'); f.child.emit('close', 0); await promise;
  expect(() => iMessageScript('bad" recipient', 'text')).toThrow();
});

test.each([['permission-denied', /Automation/], ['no-account', /Sign in/], ['failed', /no automatic retry/],
  ['failed:-1728', /AppleScript error -1728/]])('Messages %s is a controlled error', async (status, pattern) => {
  const f = fixture();
  const promise = sendIMessage('me@example.com', 'test', new AbortController().signal, f);
  f.child.stdout.end(String(status)); f.child.emit('close', 0); await failure(promise, pattern as RegExp);
});

test('compilation failures explain that nothing was sent without exposing private diagnostics', async () => {
  const f = fixture();
  const promise = sendIMessage('private@example.com', 'Private notification body', new AbortController().signal, f);
  f.child.stderr.write('14:20: syntax er');
  f.child.stderr.end('ror: private@example.com Private notification body (-1728)');
  f.child.emit('close', 1);
  const error = await failure(promise, /could not compile.*No message was sent/);
  expect(error).not.toContain('private@example.com'); expect(error).not.toContain('Private notification body');
  expect(f.calls).toHaveLength(1);
});

test.skipIf(process.platform !== 'darwin')('generated notification script compiles against the installed Messages app without sending', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-imessage-compile-test-'));
  try {
    const source = path.join(directory, 'notification.applescript');
    await writeFile(source, iMessageScript('fixture@example.com', 'Compile only. Quote " and backslash \\ and newline\n안내'));
    // osacompile checks the real application dictionary but never executes the send command.
    const result = await promisify(execFile)('/usr/bin/osacompile', ['-o', path.join(directory, 'notification.scpt'), source], { timeout: 15000 });
    expect(result.stderr).toBe('');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('timeouts and cancellation kill the process without retrying', async () => {
  const f = fixture();
  await failure(sendIMessage('me@example.com', 'test', new AbortController().signal, { ...f, timeoutMs: 2 }), /no automatic retry/);
  expect(f.child.killed).toBe(true); expect(f.calls).toHaveLength(1);
  const second = fixture(), controller = new AbortController();
  const pending = sendIMessage('me@example.com', 'test', controller.signal, second);
  controller.abort(); await failure(pending, /cancelled/); expect(second.child.killed).toBe(true);
});
