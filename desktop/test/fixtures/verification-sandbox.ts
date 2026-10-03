// Run inside a disposable Docker test worker; no model or credential access.
import { readFileSync } from 'node:fs';
const writable = process.env.PROBE_WRITE === '1';
const status = readFileSync('/proc/self/status', 'utf8');
for (const flag of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
  if (!new RegExp(`${flag}:\\s+0+\\n`).test(status)) throw new Error(`Unexpected capability: ${flag}`);
}
if (!/NoNewPrivs:\s+1\n/.test(status)) throw new Error('NoNewPrivs missing');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reachable') });
try {
  if (await (await fetch(`http://127.0.0.1:${server.port}`)).text() !== 'reachable') throw new Error('Network control failed');
  const program = `
    const fs=require('node:fs'), net=require('node:net'), assert=require('node:assert/strict');
    assert(fs.readFileSync('/workspace/login.ts','utf8').includes('accepts'));
    const probe='/workspace/.sandbox-verification-probe';
    let written=false;
    try { fs.writeFileSync(probe,'probe',{flag:'wx'}); written=true; } catch(e) { assert(['EROFS','EACCES','EPERM'].includes(e.code)); }
    if(written) fs.unlinkSync(probe);
    assert.equal(written,${JSON.stringify(writable)});
    let outside=false;
    try { fs.writeFileSync('/agent/state/.sandbox-verification-probe','probe',{flag:'wx'}); outside=true; } catch(e) { assert(['EROFS','EACCES','EPERM'].includes(e.code)); }
    if(outside) fs.unlinkSync('/agent/state/.sandbox-verification-probe');
    assert.equal(outside,false);
    const socket=net.createConnection({host:'127.0.0.1',port:${server.port}});
    socket.setTimeout(2000);
    socket.once('connect',()=>{ socket.destroy(); throw new Error('Network allowed'); });
    socket.once('timeout',()=>{ socket.destroy(); throw new Error('Network timeout without denial'); });
    socket.once('error',e=>{ assert(['EPERM','EACCES'].includes(e.code)); fs.writeFileSync(1,'SANDBOX_BOUNDARIES_PASSED\\n'); });
  `;
  const child = Bun.spawn(['codex', 'sandbox', '-P', writable ? ':workspace' : ':read-only', '-C', '/workspace', '--', 'node', '-e', program], { stdout: 'pipe', stderr: 'pipe' });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0 || !output.includes('SANDBOX_BOUNDARIES_PASSED')) throw new Error(`Sandbox check failed (${code}): ${output} ${error}`);
  console.log(JSON.stringify({ writable, projectRead: true, projectWrite: writable, stateWriteDenied: true, networkDenied: true, capabilitiesZero: true, noNewPrivileges: true }));
} finally { server.stop(true); }
