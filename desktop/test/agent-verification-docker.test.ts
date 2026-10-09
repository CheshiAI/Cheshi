import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { SPECIALIST_WORKER_FILES } from '../../scripts/prepare-specialist-worker.mts';
import type { Task } from '../../experiments/codex-specialists/src/store.ts';
import type { CollaborationState } from '../../experiments/codex-specialists/src/collaboration-contract.ts';
import { verificationResult } from '../../experiments/codex-specialists/src/verification-contract.ts';

const execute = promisify(execFile), context = process.env.CHESHI_ORCHESTRATION_DOCKER_CONTEXT;
const authContainer = process.env.CHESHI_VERIFICATION_AUTH_CONTAINER;
const real = process.env.CHESHI_TEST_REAL_CODEX === '1';
const criterion = 'Accept only nonempty email and password.';
const checks = `import { expect, test } from 'bun:test';
import { accepts } from './login.ts';
test('both credentials', () => expect(accepts('a@b.test', 'secret')).toBe(true));
test('empty email', () => expect(accepts('', 'secret')).toBe(false));
test('empty password', () => expect(accepts('a@b.test', '')).toBe(false));
test('both empty', () => expect(accepts('', '')).toBe(false));
`;

for (const native of [false, true]) test.if(Boolean(context) && (native ? real && Boolean(authContainer) : !real))(
  `${native ? 'native model' : 'scripted protocol'}: three Docker agents question, fail review, fix, reverify and complete after recreation`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cheshi-verification-docker-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace); chmodSync(workspace, 0o777);
    const prefix = `cheshi-verification-${randomUUID()}`, image = `${prefix}:test`;
    const containers = new Set<string>(), volumes = new Set<string>(), endpoints = new Map<string, string>();
    const workspaceVolume = `${prefix}-workspace`;
    const token = randomBytes(32).toString('hex');
    const peers = [{ id: 'dev', name: 'Developer', role: 'development' }, { id: 'planner', name: 'Planner', role: 'planning' }, { id: 'reviewer', name: 'Verifier', role: 'verification' }];
    const docker = async (...args: string[]) => (await execute('docker', ['--context', context!, ...args], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
    const install = async (name: string, configuration: string, auth?: string) => {
      const source = `let raw=''; for await (const c of process.stdin) raw += c; const v=JSON.parse(raw); const fs=require('node:fs'); if(v.auth) fs.writeFileSync('/agent/codex/auth.json', v.auth, {mode:0o600}); fs.writeFileSync('/agent/runtime.json',v.configuration,{mode:0o600});`;
      await new Promise<void>((resolve, reject) => {
        const child = execFile('docker', ['--context', context!, 'exec', '--interactive', name, 'bun', '-e', source], { timeout: 10_000 }, error => error ? reject(new Error('Could not install isolated test configuration.')) : resolve());
        child.stdin!.end(JSON.stringify({ configuration, auth }));
      });
    };
    const wait = async (check: () => Promise<boolean>, label: string, limit = native ? 480_000 : 30_000) => {
      const end = Date.now() + limit;
      while (Date.now() < end) { if (await check()) return; await Bun.sleep(250); }
      throw new Error(`Timed out: ${label}`);
    };
    const activity = async (id: string) => await (await fetch(`${endpoints.get(id)}/activity`)).json() as { tasks: Task[]; collaboration: CollaborationState };
    const task = async () => (await activity('dev')).tasks.find(t => t.id === 'login')!;
    const relay = () => createAgentOrchestration({ filename: join(root, 'central.json'), peer: b => peers.find(p => p.id === b.agentId) ?? null,
      connect: async b => ({ endpoint: endpoints.get(b.agentId)!, token }) });
    let coordinator = relay(), built = false;
    const start = async (id: string) => {
      const name = `${prefix}-${id}`, volume = `${name}-data`, fresh = !volumes.has(volume);
      if (fresh) { await docker('volume', 'create', '--label', `ai.cheshi.test=${prefix}`, volume); volumes.add(volume); }
      const security = fileURLToPath(new URL('../../experiments/codex-specialists/security/codex-bwrap.json', import.meta.url));
      await docker('create', '--name', name, '--label', `ai.cheshi.test=${prefix}`, '--init', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', ...(native ? ['--security-opt', `seccomp=${security}`, '--security-opt', 'apparmor=cheshi-codex-bwrap'] : []),
        '--memory', '1g', '--cpus', '2', '--pids-limit', '256', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
        '--publish', '127.0.0.1::8787', '--mount', `type=volume,src=${volume},dst=/agent`,
        ...(id === 'dev' ? ['--mount', `type=volume,src=${workspaceVolume},dst=/workspace`] : []),
        ...(!native ? ['--env', 'PATH=/test:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin', '--env', `FIXTURE_PROFILE=${id}`] : []),
        '--env', 'CODEX_HOME=/agent/codex', '--env', 'AGENT_RUNTIME_CONFIG=/agent/runtime.json', '--env', 'AGENT_RUNTIME_REVISION=test',
        '--env', 'AGENT_DATA_DIRECTORY=/agent', '--env', 'AGENT_WORKSPACE=/workspace', image);
      containers.add(name); await docker('start', name);
      if (fresh) {
        if (id === 'dev') {
          await docker('cp', `${workspace}/.`, `${name}:/workspace`);
        }
        let auth: string | undefined;
        if (native) {
          // Read only the explicitly selected source credential file; never log it or include it in an image.
          await docker('cp', `${authContainer}:/agent/codex/auth.json`, join(root, 'auth.json'));
          chmodSync(join(root, 'auth.json'), 0o600);
          auth = readFileSync(join(root, 'auth.json'), 'utf8');
          rmSync(join(root, 'auth.json'));
        }
        await install(name, readFileSync(join(root, `${id}.json`), 'utf8'), auth);
      }
      endpoints.set(id, `http://${await docker('port', name, '8787/tcp')}`);
      await wait(async () => { try { return (await fetch(`${endpoints.get(id)}/health`)).ok; } catch { return false; } }, `${id} startup`, 20_000);
    };
    try {
      mkdirSync(join(root, 'src'));
      for (const filename of SPECIALIST_WORKER_FILES.filter(file => file.startsWith('src/'))) copyFileSync(fileURLToPath(new URL(`../../experiments/codex-specialists/${filename}`, import.meta.url)), join(root, filename));
      copyFileSync(fileURLToPath(new URL('./fixtures/verification-app-server.ts', import.meta.url)), join(root, 'fixture.ts'));
      writeFileSync(join(root, 'codex'), '#!/bin/sh\nexec /usr/local/bin/bun /test/fixture.ts "$@"\n', { mode: 0o755 });
      // Only this explicit context enters the image. Credentials are copied later to disposable volumes.
      writeFileSync(join(root, 'Dockerfile'), `FROM cheshi-specialist:1\nUSER root\nRUN mkdir -p /workspace && chown node:node /workspace\nCOPY src /app/src\n${native ? '' : 'COPY fixture.ts codex /test/\nRUN chmod 755 /test/codex\n'}USER node\n`);
      await docker('build', '--network=none', '--tag', image, root); built = true;
      writeFileSync(join(workspace, 'login.ts'), 'export const accepts = (email: string, _password: string) => Boolean(email);\n', { mode: 0o666 });
      chmodSync(join(workspace, 'login.ts'), 0o666);
      writeFileSync(join(workspace, 'login.test.ts'), checks, { mode: 0o444 });
      await docker('volume', 'create', '--label', `ai.cheshi.test=${prefix}`, workspaceVolume); volumes.add(workspaceVolume);
      for (const p of peers) {
        const instructions = p.id === 'planner' ? 'Answer credential-policy questions: both email and password must be nonempty. No edits or commands.'
          : p.id === 'reviewer' ? 'Independently inspect requested artifacts, use verification_read on both files, run bun test login.test.ts with a native command tool. Report actual failing assertions or passing cases using runtime receipt IDs. Never edit files. Finish submit_verification then end the turn.'
          : 'Complete the assigned goal within /workspace only. Use peer collaboration tools; do not run agents yourself. Preserve login.test.ts exactly. Follow the explicitly requested fail-fix-reverify scenario; do not claim completion before independent verification passes.';
        writeFileSync(join(root, `${p.id}.json`), JSON.stringify({ decisionProtocol: 1, verificationProtocol: 1, profileId: p.id, accountId: 'isolated-test', role: p.role,
          token, revision: 'test', instructions, model: native ? 'gpt-6-astra' : null, reasoningEffort: native ? 'high' : null, serviceTier: null,
          permissions: { fileWrite: p.id === 'dev', commandExecution: p.id !== 'planner' } }), { mode: 0o644 });
        await start(p.id);
      }
      if (native) {
        const probe = readFileSync(fileURLToPath(new URL('./fixtures/verification-sandbox.ts', import.meta.url)), 'utf8');
        for (const id of ['dev', 'reviewer']) console.log(await docker('exec', '--env', `PROBE_WRITE=${id === 'dev' ? '1' : '0'}`, `${prefix}-${id}`, 'bun', '-e', probe));
      }
      peers.forEach(p => coordinator.register(bindingFor(workspace, 'docker:verification-test', p.id, 'isolated-test')));
      await coordinator.tick();
      const prompt = `Complete the credential validation fixture. Use exactly one persistent criterion: "${criterion}" First ask the planning agent which credentials are required, then record wait and end the turn. After its answer, request independent verification of the existing login.ts and login.test.ts BEFORE making any fix; this deliberate first failing review is part of this test. When the verification agent reports the failure, fix only login.ts, request a NEW verification round for the same two files and criterion, then wait. After a passing independent result, record complete. Use list_agents to choose peers. Keep login.test.ts unchanged. Do not poll. Execute only inside /workspace.`;
      expect((await fetch(`${endpoints.get('dev')}/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'login', prompt }) })).status).toBe(202);
      await wait(async () => (await task())?.status === 'waiting', 'initial planning question');
      const original = await task(); expect(original.goal?.phase).toBe('waiting');
      // Keep both the waiting question and its native thread, but replace its container and central process.
      await docker('kill', `${prefix}-dev`); await docker('rm', `${prefix}-dev`); containers.delete(`${prefix}-dev`);
      await coordinator.dispose(); coordinator = relay(); await start('dev');
      expect((await task()).status).toBe('waiting');
      let verificationRestarted = false, progress = '';
      await wait(async () => {
        const state = await activity('dev'), current = state.tasks.find(t => t.id === 'login')!;
        const pending = state.collaboration.outgoing.some(m => m.kind === 'verification_request');
        if (pending && current.status === 'waiting' && !verificationRestarted) {
          verificationRestarted = true;
          await coordinator.dispose();
          await docker('kill', `${prefix}-dev`); await docker('rm', `${prefix}-dev`); containers.delete(`${prefix}-dev`);
          coordinator = relay(); await start('dev');
          expect((await task()).status).toBe('waiting');
        }
        await coordinator.tick();
        const next = `${current.status}/${current.goal?.turns}/${state.collaboration.incoming.length}`;
        if (next !== progress) { console.log(`${native ? 'native' : 'fixture'} progress: ${next}`); progress = next; }
        if (['failed', 'unknown', 'interrupted'].includes(current.status)) throw new Error(`Goal stopped: ${current.error ?? current.output}`);
        return current.status === 'completed';
      }, 'fail, correction, re-verification and completion');
      const final = await task(), state = await activity('dev');
      expect(verificationRestarted).toBe(true); expect(final.threadId).toBe(original.threadId);
      expect(final.goal?.phase).toBe('completed'); expect(final.goal?.verificationRequired).toBe(true);
      const results = state.collaboration.incoming.filter(m => m.kind === 'verification_result').map(m => verificationResult(JSON.parse(m.text)));
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]!.verdicts.some(v => v.verdict === 'fail')).toBe(true);
      expect(results.at(-1)!.verdicts.every(v => v.verdict === 'pass')).toBe(true);
      expect(results.at(-1)!.evidence.some(e => e.kind === 'command' && e.exitCode === 0)).toBe(true);
      expect(state.collaboration.outgoing.filter(m => m.kind === 'verification_request')
        .every(m => JSON.parse(m.text).source?.files.length === 2)).toBe(true);
      await docker('exec', `${prefix}-reviewer`, 'test', '!', '-e', '/workspace/login.ts');
      expect(await docker('exec', `${prefix}-dev`, 'cat', '/workspace/login.test.ts')).toBe(checks.trim());
      const report = join(tmpdir(), `${prefix}-report.json`);
      writeFileSync(report, JSON.stringify({ native, final, results, verificationRestarted }, null, 2), { mode: 0o600 });
      console.log(`Verification report: ${report}`);
    } catch (error) {
      const states = await Promise.all(peers.filter(p => endpoints.has(p.id)).map(async p => ({ id: p.id, state: await activity(p.id).catch(() => null) })));
      const report = join(tmpdir(), `${prefix}-failure.json`);
      writeFileSync(report, JSON.stringify({ native, error: String(error), states }, null, 2), { mode: 0o600 });
      console.log(`Failure report: ${report}`);
      throw error;
    } finally {
      await coordinator.dispose();
      for (const name of containers) await docker('rm', '--force', name);
      for (const name of volumes) await docker('volume', 'rm', name);
      if (built) await docker('image', 'rm', image);
      rmSync(root, { recursive: true, force: true });
    }
  }, native ? 900_000 : 120_000);
