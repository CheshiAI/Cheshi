import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Run explicitly inside the verifier container; no model request is made. */
function assertCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assertCheck(process.platform === 'linux' && process.env.AGENT_DATA_DIRECTORY === '/agent',
  'Run this check inside the verifier container.');

const workspace = process.env.AGENT_WORKSPACE ?? '/workspace';
const suffix = `.sandbox-probe-${randomUUID()}`;
const source = join(workspace, 'failure-rate.ts');
const workspaceProbe = join(workspace, suffix);
const stateProbe = join('/agent/state', suffix);
const before = readFileSync(source, 'utf8');

function outerWriteControl(): void {
  writeFileSync(stateProbe, 'control', { flag: 'wx' });
  unlinkSync(stateProbe);
  let created = false;
  let code = '';
  try { writeFileSync(workspaceProbe, 'control', { flag: 'wx' }); created = true; }
  catch (error) { code = (error as NodeJS.ErrnoException).code ?? ''; }
  finally { if (created) unlinkSync(workspaceProbe); }
  assertCheck(!created && ['EROFS', 'EACCES'].includes(code), 'Docker source mount must reject writes.');
  console.log(JSON.stringify({ check: 'docker-controls', stateWritable: true, sourceWriteDenied: code }));
}

outerWriteControl();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('control-ok') });
try {
  const control = await fetch(`http://127.0.0.1:${server.port}`);
  assertCheck(await control.text() === 'control-ok', 'Network control endpoint must be reachable outside Codex.');
  // Pass arguments directly to the child, with no shell interpretation.
  const program = `
    const { readFileSync, writeFileSync, unlinkSync } = require('node:fs');
    const { createConnection } = require('node:net');
    const { strict: assert } = require('node:assert');
    const source = ${JSON.stringify(source)};
    assert.equal(readFileSync(source, 'utf8'), ${JSON.stringify(before)});
    const writes = [];
    for (const path of ${JSON.stringify([workspaceProbe, stateProbe])}) {
      let created = false;
      let code = '';
      try { writeFileSync(path, 'probe', { flag: 'wx' }); created = true; }
      catch (error) { code = error.code; }
      finally { if (created) unlinkSync(path); }
      assert(!created && ['EROFS', 'EACCES', 'EPERM'].includes(code), 'Sandbox allowed a write: ' + path);
      writes.push({ path, code });
    }
    const socket = createConnection({ host: '127.0.0.1', port: ${server.port} });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); throw new Error('Sandbox allowed network access.'); });
    socket.once('timeout', () => { socket.destroy(); throw new Error('Network check timed out without a policy denial.'); });
    socket.once('error', error => {
      assert(['EACCES', 'EPERM'].includes(error.code), 'Expected a network policy denial, got ' + error.code);
      writeFileSync(1, JSON.stringify({ check: 'codex-sandbox', sourceRead: true, writes, networkDenied: error.code }) + '\\n');
    });
  `;
  const child = Bun.spawn(['codex', 'sandbox', '-P', ':read-only', '-C', workspace, '--', 'node', '-e', program], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = setTimeout(() => child.kill(), 15_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(deadline));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  assertCheck(exitCode === 0, `Codex sandbox check failed with exit code ${exitCode}.`);
  assertCheck(stdout.includes('"check":"codex-sandbox"'), 'The sandboxed child did not report its checks.');
  assertCheck(readFileSync(source, 'utf8') === before, 'The source changed during validation.');
  console.log(JSON.stringify({ check: 'sandbox-verification', passed: true }));
} finally {
  server.stop(true);
}
