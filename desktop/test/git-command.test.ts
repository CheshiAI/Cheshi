import assert from 'node:assert/strict';
import test from 'node:test';
import { GitCommandError, runCommand } from '../lib/git-command.mts';

async function commandError(operation: Promise<unknown>): Promise<GitCommandError> {
  try { await operation; }
  catch (error) { assert.ok(error instanceof GitCommandError); return error; }
  assert.fail('Expected a Git command error.');
}

const options = { cwd: process.cwd(), timeout: 500 };

test('timeout retains stdout, stderr and final output even when SIGTERM exits successfully', async () => {
  const error = await commandError(runCommand(process.execPath, ['--eval', `
    process.stdout.write('fetch started\\n');
    process.stderr.write('remote waiting\\n');
    process.on('SIGTERM', () => { process.stderr.write('cleanup finished\\n'); process.exit(0); });
    setInterval(() => {}, 1000);
  `], options));
  assert.match(error.message, /timed out after 500 ms/);
  assert.equal(error.stdout, 'fetch started\n');
  assert.equal(error.stderr, 'remote waiting\ncleanup finished\n');
  assert.equal(error.exitCode, 0);
  assert.equal(error.signal, null);
  assert.equal(error.timedOut, true);
  assert.equal(error.terminationConfirmed, true);
  assert.equal(error.truncated, false);
});

test('timeout escalates for a child that ignores SIGTERM and bounds diagnostic output', async () => {
  const error = await commandError(runCommand(process.execPath, ['--eval', `
    process.on('SIGTERM', () => {});
    process.stdout.write('x'.repeat(100)); process.stderr.write('y'.repeat(100));
    setInterval(() => {}, 1000);
  `], { ...options, maxBytes: 8 }));
  assert.equal(error.stdout, 'xxxxxxxx');
  assert.equal(error.stderr, 'yyyyyyyy');
  assert.equal(error.truncated, true);
  assert.equal(error.exitCode, null);
  assert.equal(error.signal, 'SIGKILL');
  assert.equal(error.terminationConfirmed, true);
});

test('timeout waits for a detached command group including a helper surviving its parent', { skip: process.platform === 'win32' }, async () => {
  const error = await commandError(runCommand(process.execPath, ['--eval', `
    const { spawn } = require('node:child_process');
    const helper = spawn(process.execPath, ['--eval', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    console.log(helper.pid);
    setInterval(() => {}, 1000);
  `], options));
  const helperPid = Number(error.stdout.trim());
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  assert.equal(error.signal, 'SIGTERM');
  assert.equal(error.terminationConfirmed, true);
  assert.throws(() => process.kill(helperPid, 0), { code: 'ESRCH' });
});

test('normal results and accepted nonzero exits keep their existing contract', async () => {
  const result = await runCommand(process.execPath, ['--eval', "process.stdout.write('result'); process.stderr.write('note'); process.exit(7)"],
    { ...options, acceptedExitCodes: [7] });
  assert.deepEqual(result, { stdout: 'result', stderr: 'note', exitCode: 7, truncated: false });
  const error = await commandError(runCommand(process.execPath, ['--eval', "process.stdout.write('partial'); process.stderr.write('failed'); process.exit(2)"], options));
  assert.equal(error.stdout, 'partial');
  assert.equal(error.stderr, 'failed');
  assert.equal(error.exitCode, 2);
  assert.equal(error.timedOut, false);
  assert.equal(error.terminationConfirmed, null);
});

test('spawn failures settle without being misreported as timeouts', async () => {
  const error = await commandError(runCommand('/cheshi-test-missing-executable', [], options));
  assert.match(error.message, /ENOENT/);
  assert.equal(error.timedOut, false);
  assert.equal(error.command, '/cheshi-test-missing-executable');
});
