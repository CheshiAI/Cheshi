import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpecialistAgent } from '../../shared/agent-registry.ts';
import type { AgentRuntimeRequest, AgentRuntimeState } from '../../shared/agent-runtime.ts';
import { parseAgentRuntimeRequest } from '../../shared/agent-runtime.ts';
import { agentRecord } from '../../shared/agent-management.ts';
import type { AgentManagementApi } from '../../shared/agent-management.ts';
import type { createAgentRegistry } from './registry.mts';
import { parseDockerAgent, runDocker, type DockerCommand } from './docker.mts';
import { DockerCommandError } from './docker-errors.mts';
import { assertAgentModelSelection, type AgentModel } from '../../shared/agent-models.ts';
import { workerOperations } from './operations.mts';
import { resolveAgentInstructions } from './instruction-files.mts';
import { createAgentOrchestration, type exchangeWorker } from '../agent-orchestration/service.mts';
import type { AgentHistoryOptions } from '../agent-orchestration/history-relay.mts';
import { bindingFor } from '../agent-orchestration/mailbox.mts';

export interface RuntimeAccount { home: string; models: AgentModel[]; }
interface RuntimeOptions {
  directory: string; buildContext: string;
  registry: ReturnType<typeof createAgentRegistry>; management: AgentManagementApi;
  account(id: string): Promise<RuntimeAccount>;
  run?: DockerCommand;
  collaborationExchange?: typeof exchangeWorker;
  history?: AgentHistoryOptions;
  rooms?: Parameters<typeof createAgentOrchestration>[0]['rooms'];
}
const image = 'cheshi-specialist:1';
const marker = 'ai.cheshi.worker';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const installAuth = "const fs=require('node:fs');const v=JSON.parse(await Bun.stdin.text());fs.mkdirSync('/agent/codex',{recursive:true});fs.writeFileSync('/agent/codex/auth.json',v.auth,{mode:0o600});if(v.configuration){fs.writeFileSync('/agent/runtime.json.tmp',JSON.stringify(v.configuration),{mode:0o600});fs.renameSync('/agent/runtime.json.tmp','/agent/runtime.json');}";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function projectAssignment(agent: SpecialistAgent, workspace: string) {
  return agent.assignments.find(assignment => {
    if (assignment.workspaceRoot === workspace) return true;
    try { return realpathSync(assignment.workspaceRoot) === workspace; }
    catch { return false; }
  });
}

function serializeRuntimeAuth(value: unknown): string {
  const raw = agentRecord(value), tokens = agentRecord(raw.tokens);
  for (const key of ['access_token', 'refresh_token', 'id_token', 'account_id']) {
    if (typeof tokens[key] !== 'string' || !tokens[key]) throw new Error('Incomplete ChatGPT credentials.');
  }
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      id_token: tokens.id_token, account_id: tokens.account_id }, last_refresh: raw.last_refresh });
}
function assertCredentialSize(size: number): void {
  if (size > 128_000) throw new Error('Invalid credential size.');
}
/** Credentials go directly to this worker's private volume, never through IPC or command arguments. */
export async function readRuntimeAuth(home: string): Promise<string> {
  try {
    const filename = join(await realpath(home), 'auth.json');
    assertCredentialSize((await stat(filename)).size);
    return serializeRuntimeAuth(JSON.parse(await readFile(filename, 'utf8')));
  } catch { throw new Error('Sign in to the selected ChatGPT account with file credential storage before starting its worker.'); }
}

export function createSpecialistRuntime(options: RuntimeOptions) {
  const run = options.run ?? runDocker;
  const pending = new Set<string>();
  const builds = new Map<string, Promise<void>>();
  const orchestration = createAgentOrchestration({ filename: join(options.directory, 'collaboration.json'),
    exchange: options.collaborationExchange, history: options.history, rooms: options.rooms,
    peer: binding => {
      const agent = options.registry.snapshot(binding.workspace).agents.find(a => a.id === binding.agentId && a.accountId === binding.accountId
        && projectAssignment(a, binding.workspace));
      return agent ? { id: agent.id, name: agent.name, role: agent.role } : null;
    },
    connect: async binding => {
      const key = `${binding.agentId}-${digest(binding.workspace).slice(0, 16)}`;
      const prefix = await local(binding.engineId);
      const worker = await find(prefix, key);
      if (!worker || worker.state !== 'running' || !worker.endpoint) return null;
      const saved = agentRecord(JSON.parse(await readFile(join(options.directory, digest(binding.engineId), key, 'runtime.json'), 'utf8')));
      if (saved.accountId !== binding.accountId || saved.profileId !== binding.agentId || saved.revision !== worker.fingerprint
        || saved.collaborationProtocol !== 1 || saved.historyProtocol !== 1 || saved.decisionProtocol !== 1 || saved.verificationProtocol !== 1 || typeof saved.token !== 'string' || !/^[a-f0-9]{64}$/.test(saved.token)) {
        throw new Error('Start the agent to reconnect collaboration with its current settings.');
      }
      const agent = options.registry.snapshot(binding.workspace).agents.find(a => a.id === binding.agentId);
      const assignment = agent && projectAssignment(agent, binding.workspace);
      if (!agent || !assignment || saved.settingsFingerprint !== settingsDigest(agent, binding.workspace, assignment)) {
        throw new Error('Settings changed. Start the agent to resume collaboration.');
      }
      return { endpoint: worker.endpoint, token: saved.token };
    },
  });
  async function local(engineId: string) {
    if (!engineId.startsWith('docker:')) throw new Error('This execution engine cannot create specialist workers.');
    const contexts: unknown = JSON.parse(await run(['context', 'inspect', engineId.slice(7)]));
    if (!Array.isArray(contexts)) throw new Error('Invalid execution engine.');
    const host = agentRecord(agentRecord(agentRecord(contexts[0]).Endpoints).docker).Host;
    if (typeof host !== 'string' || !host.startsWith('unix:///')) throw new Error('Only local engines can run project agents.');
    return ['--host', host];
  }
  async function rememberEngine(directory: string, engineId: string, host: string) {
    const filename = join(directory, 'engine.json');
    let previous: Record<string, unknown> | null = null;
    try { previous = agentRecord(JSON.parse(await readFile(filename, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.engineId !== engineId || previous.host !== host) {
        throw new Error(`Worker engine ${engineId} changed. Restore its original connection before continuing.`);
      }
      return;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(`${filename}.tmp`, JSON.stringify({ engineId, host }), { mode: 0o600 });
    await rename(`${filename}.tmp`, filename);
  }
  async function find(prefix: string[], key: string) {
    const ids = (await run([...prefix, 'container', 'ls', '--all', '--no-trunc', '--filter', `label=${marker}=specialist-v1`,
      '--filter', `label=ai.cheshi.binding=${key}`, '--format', '{{.ID}}'])).trim().split(/\s+/).filter(Boolean);
    if (ids.length > 1) throw new Error('Multiple workers have this project assignment. Inspect them in Docker.');
    if (!ids[0]) return null;
    if (!/^[a-f0-9]{64}$/.test(ids[0])) throw new Error('Invalid worker identity.');
    const records: unknown = JSON.parse(await run([...prefix, 'container', 'inspect', ids[0]]));
    if (!Array.isArray(records)) throw new Error('Invalid worker inspection.');
    const raw = agentRecord(records[0]), labels = agentRecord(agentRecord(raw.Config).Labels);
    if (labels[marker] !== 'specialist-v1' || labels['ai.cheshi.binding'] !== key) throw new Error('Worker ownership changed.');
    const worker = parseDockerAgent(raw);
    if (worker.id !== ids[0]) throw new Error('Worker identity changed.');
    return { ...worker, fingerprint: labels['ai.cheshi.configuration'] };
  }
  async function build(prefix: string[]) {
    const key = prefix.join('/');
    let flight = builds.get(key);
    if (!flight) {
      flight = run([...prefix, 'build', '--tag', image, options.buildContext]).then(() => {});
      builds.set(key, flight);
      void flight.catch(() => builds.delete(key));
    }
    await flight;
  }
  async function post(endpoint: string, token: string, route: string, body: unknown) {
    const response = await fetch(`${endpoint}${route}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) }).catch(() => { throw Object.assign(new Error('Delivery outcome is unknown. Inspect the saved worker task.'), { deliveryUncertain: true }); });
    if (response.status >= 500) { await response.body?.cancel(); throw Object.assign(new Error('Worker outcome is unknown. Inspect its task record.'), { deliveryUncertain: true }); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 409 ? 'The worker is busy or this task needs inspection.' : 'Worker did not accept the request. Refresh its status before retrying.'); }
    await response.body?.cancel();
  }
  async function waitReady(engineId: string, id: string) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const details = await options.management.details(engineId, id);
      if (details.ready && details.authenticated === true) return details;
      if (details.agent.state !== 'running') throw new Error('Worker stopped during startup. Inspect its logs in Docker.');
      await delay(1000);
    }
    throw new Error('Worker is still starting or needs sign-in. Refresh its status in a moment.');
  }
  async function request(workspaceRoot: string, input: AgentRuntimeRequest, chat?: { roomId: string; conversation: string; goal: boolean; inputId?: string }): Promise<AgentRuntimeState> {
    const request = parseAgentRuntimeRequest(input);
    const workspace = await realpath(workspaceRoot);
    const agent = options.registry.snapshot(workspaceRoot).agents.find(item => item.id === request.agentId);
    const assignment = agent?.assignments.find(item => item.workspaceRoot === workspaceRoot);
    if (!agent || !assignment) throw new Error('Assign this agent to the current project first.');
    const key = `${agent.id}-${digest(workspace).slice(0, 16)}`;
    const assertCurrent = () => {
      if (options.registry.snapshot(workspaceRoot).agents.find(item => item.id === agent.id)?.revision !== agent.revision) {
        throw new Error('Agent settings changed. Try again.');
      }
    };
    if (request.action !== 'status' && pending.has(key)) throw new Error('An operation for this agent is already running.');
    if (request.action !== 'status') pending.add(key);
    try {
      const directory = join(options.directory, digest(request.engineId), key);
      const configPath = join(directory, 'runtime.json');
      const settingsFingerprint = settingsDigest(agent, workspace, assignment);
      const instructions = request.action === 'start' ? await resolveAgentInstructions(agent, assignment) : null;
      const hasFiles = Boolean(agent.instructionFiles?.length || assignment.instructionFiles?.length);
      const fingerprint = hasFiles && instructions !== null ? digest(`${settingsFingerprint}\n${instructions}`) : settingsFingerprint;
      const prefix = await local(request.engineId);
      let worker = await find(prefix, key);
      // Status/submit use the snapshot applied at Start; editing a source file takes effect at the next Start.
      const applied = worker && request.action !== 'start' && request.action !== 'cancel'
        ? agentRecord(JSON.parse(await readFile(configPath, 'utf8'))) : null;
      const settingsChanged = applied?.settingsFingerprint === undefined
        ? worker?.fingerprint !== settingsFingerprint
        : applied.settingsFingerprint !== settingsFingerprint || applied.revision !== worker?.fingerprint;
      if (request.action === 'status') {
        const details = worker ? await options.management.details(request.engineId, worker.id) : null;
        if (details && settingsChanged) details.error = 'Settings changed. Start the agent to apply them.';
        const collaborationError = orchestration.error(bindingFor(workspace, request.engineId, agent.id, agent.accountId ?? '').id);
        if (details && collaborationError && !details.error) details.error = collaborationError;
        return { details };
      }
      if (request.action === 'cancel') {
        if (!worker?.endpoint) throw new Error('Worker is unavailable.');
        const saved = agentRecord(JSON.parse(await readFile(configPath, 'utf8')));
        if (typeof saved.token !== 'string') throw new Error('Worker authorization is unavailable.');
        await post(worker.endpoint, saved.token, `/tasks/${request.taskId}/stop`, {});
        return { details: await options.management.details(request.engineId, worker.id) };
      }
      if (!agent.accountId) throw new Error('Select an account in agent settings first.');
      const account = await options.account(agent.accountId);
      assertAgentModelSelection(agent, account.models);
      const selectedAuth = await readRuntimeAuth(account.home);
      const selectedAccount = digest(String(agentRecord(agentRecord(JSON.parse(selectedAuth)).tokens).account_id));
      if (worker) {
        const previous = agentRecord(JSON.parse(await readFile(configPath, 'utf8')));
        if (previous.accountId === agent.accountId) {
          let identity = typeof previous.accountFingerprint === 'string' ? previous.accountFingerprint : '';
          if (worker.state === 'running') {
            const current = (await run([...prefix, 'exec', worker.id, 'bun', '-e',
              "const fs=require('node:fs');if(fs.existsSync('/agent/codex/auth.json')){const id=JSON.parse(fs.readFileSync('/agent/codex/auth.json','utf8')).tokens?.account_id;if(id)console.log(require('node:crypto').createHash('sha256').update(id).digest('hex'));}"])).trim();
            identity = current || identity;
          }
          if (identity && identity !== selectedAccount) throw new Error('This worker belongs to an earlier sign-in. Select a separate account profile to keep its conversation isolated.');
          if (!identity && worker.state !== 'running') throw new Error('Start this worker in Docker to verify its previous sign-in before reconnecting.');
        }
      }
      // Avoid starting work under a profile edited while account checks were in flight.
      assertCurrent();
      if (request.action === 'start') {
        await rememberEngine(directory, request.engineId, prefix[1]!);
        const auth = selectedAuth;
        if (!worker || worker.fingerprint !== fingerprint) await build(prefix);
        assertCurrent();
        if (worker && worker.fingerprint !== fingerprint) {
          const details = await options.management.details(request.engineId, worker.id);
          if (worker.state === 'running') {
            if (!details.ready || details.busy || details.tasks.some(task => task.status === 'unknown')) throw new Error('Wait for this worker or inspect its unfinished task before applying settings.');
            await run([...prefix, 'container', 'stop', '--time', '15', worker.id]);
          }
          await run([...prefix, 'container', 'rm', worker.id]);
          worker = null; // Preserve the named volume and all conversations/results.
        }
        if (!worker) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const configuration = { accountFingerprint: selectedAccount, revision: fingerprint, settingsFingerprint,
            ...profileConfiguration(agent), collaborationProtocol: 1, historyProtocol: 1, decisionProtocol: 1, verificationProtocol: 1, chatsProtocol: 1, profileId: agent.id, token: randomBytes(32).toString('hex'), instructions };
          await writeFile(`${configPath}.tmp`, JSON.stringify(configuration), { mode: 0o600 });
          await rename(`${configPath}.tmp`, configPath);
          const mounts = [workspace];
          if (mounts.some(value => /[,\n\r]/.test(value))) throw new Error('This project path cannot be mounted by Docker.');
          const security = ['--security-opt', `seccomp=${join(options.buildContext, 'security', 'codex-bwrap.json')}`];
          if (request.engineId.startsWith('docker:colima')) security.push('--security-opt', 'apparmor=cheshi-codex-bwrap');
          await run([...prefix, 'container', 'create', '--name', `cheshi-agent-${key}`, '--init', '--user', '1000:1000', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...security,
            '--pids-limit', '256', '--cpus', '2', '--memory', '2g', '--publish', '127.0.0.1::8787',
            '--label', `${marker}=specialist-v1`, '--label', `ai.cheshi.agent=${agent.id}`, '--label', `ai.cheshi.binding=${key}`,
            '--label', `ai.cheshi.configuration=${fingerprint}`,
            '--mount', `type=volume,src=cheshi-agent-${key}-${digest(agent.accountId).slice(0, 8)},dst=/agent`,
            '--mount', `type=bind,src=${workspace},dst=/workspace${agent.permissions.fileWrite ? '' : ',readonly'}`,
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
            '--env', 'CODEX_HOME=/agent/codex', '--env', 'AGENT_DATA_DIRECTORY=/agent', '--env', 'AGENT_WORKSPACE=/workspace',
            '--env', 'AGENT_RUNTIME_CONFIG=/agent/runtime.json', '--env', `AGENT_RUNTIME_REVISION=${fingerprint}`, image]);
          worker = await find(prefix, key);
          if (!worker) throw new Error('Created worker could not be verified.');
          await run([...prefix, 'container', 'start', worker.id]);
          await run([...prefix, 'exec', '--interactive', worker.id, 'bun', '-e', installAuth], JSON.stringify({ auth, configuration }));
        } else {
          const wasStopped = worker.state !== 'running';
          if (wasStopped) await run([...prefix, 'container', 'start', worker.id]);
          const current = await options.management.details(request.engineId, worker.id);
          const needsLogin = current.ready && current.authenticated === false && !current.busy;
          const bootstrapPending = !current.ready && (await run([...prefix, 'exec', worker.id, 'bun', '-e',
            "const fs=require('node:fs');console.log(fs.existsSync('/agent/runtime.json') ? 'configured' : 'pending');"])).trim() === 'pending';
          if (wasStopped || needsLogin || bootstrapPending) {
            const configuration = agentRecord(JSON.parse(await readFile(configPath, 'utf8')));
            if (configuration.revision !== fingerprint) throw new Error('Worker settings could not be recovered.');
            const credentials = auth;
            await run([...prefix, 'exec', '--interactive', worker.id, 'bun', '-e', installAuth], JSON.stringify({ auth: credentials, configuration }));
            // A previously initialized app-server must reload the refreshed credentials.
            if (!bootstrapPending) await run([...prefix, 'container', 'restart', '--time', '15', worker.id]);
          }
        }
        const details = await waitReady(request.engineId, worker.id);
        orchestration.register(bindingFor(workspace, request.engineId, agent.id, agent.accountId));
        await orchestration.tick();
        return { details };
      }
      if (!worker || worker.state !== 'running' || !worker.endpoint) throw new Error('Start this agent first.');
      if (settingsChanged) throw new Error('Settings changed. Start the agent to apply them.');
      const configuration = agentRecord(JSON.parse(await readFile(configPath, 'utf8')));
      if (typeof configuration.token !== 'string' || !/^[a-f0-9]{64}$/.test(configuration.token)) throw new Error('Worker authorization is unavailable.');
      assertCurrent();
      if (chat && configuration.chatsProtocol !== 1) throw new Error('Start the agent to enable Chats.');
      await post(worker.endpoint, configuration.token, chat?.inputId ? `/tasks/${request.taskId}/input` : '/tasks',
        chat?.inputId ? { id: chat.inputId, prompt: request.prompt, roomId: chat.roomId }
          : { id: request.taskId, prompt: request.prompt, ...(chat ? { chat } : {}) });
      return { details: await options.management.details(request.engineId, worker.id) };
    } catch (error) {
      if (request.action === 'status' && error instanceof DockerCommandError && error.kind === 'engine-unavailable') {
        return { details: null, unavailable: { kind: error.kind, message: error.message } };
      }
      throw error;
    } finally { if (request.action !== 'status') pending.delete(key); }
  }
  return {
    chat: (workspace: string, input: AgentRuntimeRequest, context: { roomId: string; conversation: string; goal: boolean; inputId?: string }) => workerOperations.run(() => request(workspace, input, context)),
    start: orchestration.start,
    dispose: orchestration.dispose,
    request: (workspaceRoot: string, input: AgentRuntimeRequest) => input.action === 'status'
      ? request(workspaceRoot, input) : workerOperations.run(() => request(workspaceRoot, input)),
  };
}
function settingsDigest(agent: SpecialistAgent, workspace: string, assignment: SpecialistAgent['assignments'][number]) {
  return digest(JSON.stringify({ sandboxProtocol: 2, collaborationProtocol: 1, historyProtocol: 1, decisionProtocol: 1, verificationProtocol: 1, chatsProtocol: 1, agent: profileConfiguration(agent), workspace, instructions: assignment.instructions,
    ...(assignment.instructionFiles?.length ? { instructionFiles: assignment.instructionFiles } : {}) }));
}
function profileConfiguration(agent: SpecialistAgent) {
  return { role: agent.role, accountId: agent.accountId, model: agent.model, reasoningEffort: agent.reasoningEffort,
    serviceTier: agent.serviceTier, permissions: agent.permissions, instructions: agent.instructions,
    ...(agent.instructionFiles?.length ? { instructionFiles: agent.instructionFiles } : {}) };
}
