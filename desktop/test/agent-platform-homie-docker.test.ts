import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHomieExecutor, type HomieExecutionProfile } from '../lib/agent-platform/homie-executor.mts';
import { createPlatformDockerExecutor } from '../lib/agent-management/platform-executor.mts';
import { runDocker, type DockerCommand } from '../lib/agent-management/docker.mts';
import { fixture, plan, taskInput } from './agent-platform-fixtures.ts';

// Replace only the model-facing worker; transport, mounts, security, native Codex sandbox and Git are real.
const sandboxProgram = `
  const fs=require('node:fs'), assert=require('node:assert/strict');
  const link=fs.readFileSync('/workspace/.git','utf8');
  assert(!fs.existsSync(link.trim().slice(8)));
  assert(!fs.existsSync('/var/run/docker.sock'));
  for(const path of ['/workspace/.git','/agent/runtime.json']) {
    let blocked=false;try{fs.writeFileSync(path,'forbidden')}catch{blocked=true}
    assert(blocked,'Sandbox must protect '+path);
  }
  fs.writeFileSync('/workspace/feature.txt','isolated native sandbox');
  fs.writeFileSync(1,'NATIVE_WORKTREE_SANDBOX_PASSED');
`;
const worker = `
  const fs=require('node:fs'); let task=null;
  Bun.serve({hostname:'127.0.0.1',port:8787,async fetch(request){
    if(!fs.existsSync('/agent/runtime.json'))return Response.json({ready:false});
    const config=JSON.parse(fs.readFileSync('/agent/runtime.json','utf8'));
    if(request.headers.get('Authorization')!=='Bearer '+config.token)return new Response('',{status:401});
    const route=new URL(request.url).pathname;
    if(route==='/health')return Response.json({ready:true});
    if(route==='/account')return Response.json({authenticated:fs.existsSync('/agent/codex/auth.json')});
    if(route==='/tasks'){
      const input=await request.json();
      const child=Bun.spawn(['codex','sandbox','-P',':workspace','-C','/workspace','--','node','-e',${JSON.stringify(sandboxProgram)}],{stdout:'pipe',stderr:'pipe'});
      const [code,output,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      task={id:input.id,status:code===0?'completed':'failed',threadId:'simulated-model-session',output,error:code===0?null:'Sandbox exit '+code+': '+error};
      return Response.json({id:input.id,status:'accepted'},{status:202});
    }
    return Response.json(task);
  }});
`;

const context = process.env.CHESHI_PLATFORM_DOCKER_CONTEXT;
test.if(Boolean(context))('real isolated Homie transport runs a native sandbox and commits only after container shutdown', async () => {
  const engineId = `docker:${context}`, offline = await createPlatformDockerExecutor({ engineId, permissions: { fileWrite: true, commandExecution: true } });
  const image = await offline.resolveImage('cheshi-specialist:1');
  const run: DockerCommand = (args, input) => runDocker(args[3] === 'create' ? [...args.slice(0, -1), '-e', worker] : args, input);
  const profile: HomieExecutionProfile = { agentId: 'agent-feature', accountId: 'fixture-account', assertCurrent() {},
    credentials: async () => JSON.stringify({ fixture: true }), configuration: { accountId: 'fixture-account', profileId: 'agent-feature',
      role: 'development', instructions: 'Fixture only', model: null, reasoningEffort: null, serviceTier: null,
      permissions: { fileWrite: true, commandExecution: true }, enabledTools: [] } };
  const homie = await createHomieExecutor({ engineId, profile, run, pollMs: 100,
    buildContext: fileURLToPath(new URL('../../experiments/codex-specialists', import.meta.url)) });
  const f = await fixture(homie);
  try {
    f.platform.enqueue({ ...taskInput('feature'), execution: { ...plan, image, timeoutMs: 30_000, memoryMb: 1024 } });
    const result = await f.platform.runTask('feature'), attempt = result.attempts[0]!;
    expect(attempt.error).toBeNull();
    expect(readFileSync(join(attempt.workspace, 'feature.txt'), 'utf8')).toBe('isolated native sandbox');
    expect(attempt.receipt).toMatchObject({ exitCode: 0, output: expect.stringContaining('NATIVE_WORKTREE_SANDBOX_PASSED') });
    expect(result.status).toBe('succeeded'); expect(attempt.receipt?.session?.threadId).toBe('simulated-model-session');
    expect(await homie.inspect(attempt.id)).toBe('stopped');
    expect(existsSync(join(f.repository, 'feature.txt'))).toBe(false);
    expect(readFileSync(join(f.directory, 'state.json'), 'utf8')).not.toContain('"fixture":true');
  } finally {
    for (const task of f.platform.snapshot().tasks) for (const attempt of task.attempts) await homie.cleanup(attempt.id);
    f.dispose();
  }
}, 60_000);
