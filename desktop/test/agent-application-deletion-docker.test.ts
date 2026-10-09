import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { assertStoredApplications } from '../lib/agent-management/application-deletion.mts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';

const execute = promisify(execFile), context = process.env.CHESHI_DELETION_DOCKER_CONTEXT;
async function failure(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test.if(Boolean(context))('storage inspection reads private mixed-UID records without changing data or bypassing recovery guards', async () => {
  const volume = `cheshi-deletion-test-${randomUUID()}`;
  const docker: DockerCommand = async args => (await execute('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const host = await docker(['context', 'inspect', context!, '--format', '{{.Endpoints.docker.Host}}']);
  if (!host.startsWith('unix://')) throw new Error('This test requires a local Docker engine.');
  const prefix = ['--host', host];
  const fixture = async (script: string) => docker([...prefix, 'run', '--rm', '--pull', 'never', '--network', 'none',
    '--read-only', '--user', '0:0', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${volume},dst=/agent`, '--entrypoint', 'node', 'cheshi-specialist:1', '-e', script]);
  const state = '/agent/state/agent.json', candidate = 'a'.repeat(64), journal = `/agent/integrations/${candidate}/application.json`;
  const receipt = { id: 'b'.repeat(64), candidateId: candidate, hash: 'c'.repeat(64), verificationId: 'd'.repeat(64),
    status: 'interrupted', updatedAt: '2026-10-04T00:00:00Z', files: [{ path: 'file.txt', before: 'e'.repeat(64), after: 'f'.repeat(64), phase: 'writing' }] };
  const capture = () => fixture(`const fs=require('node:fs'),crypto=require('node:crypto');
    console.log(JSON.stringify(${JSON.stringify([state, journal])}.map(path=>{
      const s=fs.statSync(path); return {uid:s.uid,gid:s.gid,mode:s.mode,mtime:s.mtimeMs,
        hash:crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')};})));`);
  await docker([...prefix, 'volume', 'create', volume]);
  try {
    await fixture(`const fs=require('node:fs');
      fs.mkdirSync('/agent/state',{recursive:true}); fs.mkdirSync('/agent/integrations/${candidate}',{recursive:true});
      fs.writeFileSync('${state}',JSON.stringify({tasks:[]}),{mode:0o600});
      fs.writeFileSync('${journal}',JSON.stringify(${JSON.stringify({ ...receipt, status: 'aborted', lockReleased: true })}),{mode:0o600});
      for(const path of ['/agent/state','${state}']) fs.chownSync(path,501,20);
      for(const path of ['/agent/integrations','/agent/integrations/${candidate}','${journal}']) fs.chownSync(path,1000,1000);
      for(const path of ['/agent/state','/agent/integrations','/agent/integrations/${candidate}']) fs.chmodSync(path,0o700);`);
    const before = await capture();
    const guarded: DockerCommand = async args => {
      const script = args.at(-1)!;
      // Exercise the actual production mount and capabilities, not just flag assertions.
      const readonly = `for(const path of ['${state}','/cheshi-write-test']){
        let code; try { require('node:fs').writeFileSync(path,'must not write'); } catch(e) { code=e.code; }
        if(!['EROFS','EACCES','EPERM'].includes(code)) throw new Error('Reader was writable'); }`;
      return docker([...args.slice(0, -1), readonly + script]);
    };
    await assertStoredApplications(guarded, host, volume);
    expect(await capture()).toBe(before);
    // Reproduce the previous image-user reader's failure on the same private data.
    await failure(docker([...prefix, 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--mount', `type=volume,src=${volume},dst=/agent,readonly`, '--entrypoint', 'node', 'cheshi-specialist:1', '-e',
      `require('node:fs').readFileSync('${state}')`]), 'EACCES');
    await fixture(`const fs=require('node:fs'); fs.writeFileSync('${journal}',JSON.stringify(${JSON.stringify(receipt)}));`);
    const unresolved = await capture();
    await failure(assertStoredApplications(docker, host, volume), 'Unresolved project application');
    expect(await capture()).toBe(unresolved);
    await fixture(`require('node:fs').writeFileSync('${state}','{corrupt');`);
    await failure(assertStoredApplications(docker, host, volume), 'saved data was preserved');
  } finally { await docker([...prefix, 'volume', 'rm', volume]); }
}, 90_000);
