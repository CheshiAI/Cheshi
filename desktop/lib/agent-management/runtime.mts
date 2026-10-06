import { assertProjectEnvironment, prepareProjectEnvironment } from './project-environment.mts';
import { projectDependencies, prepareDependencies } from './dependencies.mts';
import { coversPermissions, type PermissionRequest } from '../../../experiments/codex-specialists/src/execution-permissions.ts';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPermissions } from '../../shared/agent-registry.ts';
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
import { WorkerLifecycle } from './lifecycle.mts';
import { bindingFor, type Binding } from '../agent-orchestration/mailbox.mts';

export interface RuntimeAccount { home: string; models: AgentModel[]; }
interface RuntimeOptions {
  directory: string; buildContext: string;
  registry: ReturnType<typeof createAgentRegistry>; management: AgentManagementApi;
  account(id: string): Promise<RuntimeAccount>;
  run?: DockerCommand;
  checkProjectEnvironment?: typeof assertProjectEnvironment;
  collaborationExchange?: typeof exchangeWorker;
  history?: AgentHistoryOptions;
  lifecycleControl?: (connection: { endpoint: string; token: string }, action: string, body?: unknown) => Promise<unknown>;
  idleMs?: number; now?(): number;
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
  const listeners = new Set<(binding: Binding) => void>();
  let started = false, unsubscribeRegistry: (() => void) | undefined, unsubscribeHistory: (() => void) | undefined;
  const changed = (binding: Binding) => { for (const listener of listeners) listener(binding); };
  const run = options.run ?? runDocker;
  const pending = new Set<string>();
  const builds = new Map<string, Promise<void>>();
  const orchestration = createAgentOrchestration({ filename: join(options.directory, 'collaboration.json'),
    exchange: options.collaborationExchange, history: options.history, rooms: options.rooms,
    peer: binding => {
      const agent = options.registry.snapshot(binding.workspace).agents.find(a => a.id === binding.agentId && a.accountId === binding.accountId
        && projectAssignment(a, binding.workspace));
      return agent ? { id: agent.id, name: agent.name, role: agent.role, fileWrite: projectPermissions(agent, binding.workspace).fileWrite, workProtocol: 1 } : null;
    },
    around: (binding, operation) => lifecycle.exclusive(binding, operation),
    connect: (binding, demand) => lifecycle.connection(binding, demand),
    rest: (binding, connection, busy) => lifecycle.rest(binding, connection, busy),
    nextCheck: binding => lifecycle.nextCheck(binding),
    sleeping: binding => ['sleeping', 'disabled'].includes(lifecycle.state(binding)?.phase ?? ''),
    changed: binding => { lifecycle.activity(binding); changed(binding); },
  });
  const lifecycle = new WorkerLifecycle({ filename: join(options.directory, 'lifecycle.json'), changed: binding => { changed(binding);
    if (started && lifecycle.state(binding)?.phase !== 'running') orchestration.notify(binding); }, maintenance: binding => orchestration.notify(binding), idleMs: options.idleMs, now: options.now,
    inspect: readLive,
    start: async binding => {
      await request(binding.workspace, { action: 'start', engineId: binding.engineId, agentId: binding.agentId });
      const live = await readLive(binding);
      if (!live) throw new Error('Worker did not become available.');
      return live;
    },
    demand: binding => orchestration.pending(binding) || options.rooms?.pending?.(binding) === true,
    control: options.lifecycleControl ?? lifecycleControl,
    stopped: async (binding, id) => {
      const prefix = await local(binding.engineId);
      for (let attempt = 0; attempt < 30; attempt++) {
        const worker = await find(prefix, `${binding.agentId}-${digest(binding.workspace).slice(0, 16)}`);
        if (worker?.id !== id) return false;
        if (worker.state === 'exited') return true;
        await delay(1000);
      }
      return false;
    },
  });
  async function lifecycleControl(connection: { endpoint: string; token: string }, action: string, body: unknown = {}) {
    const response = await fetch(`${connection.endpoint}/lifecycle/${action}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Worker sleep control is unavailable. Update or inspect the worker.'); }
    const text = await response.text();
    if (text.length > 4000) throw new Error('Invalid worker lifecycle response.');
    return JSON.parse(text) as unknown;
  }
  async function readLive(binding: Binding) {
    const key = `${binding.agentId}-${digest(binding.workspace).slice(0, 16)}`;
    const prefix = await local(binding.engineId);
    const worker = await find(prefix, key);
    if (worker && worker.state !== 'running' && !lifecycle.permitsStoppedWake(binding)) {
      lifecycle.disable(binding); throw new Error('Worker is stopped. Start it explicitly to enable automatic wake.');
    }
    if (!worker || worker.state !== 'running' || !worker.endpoint) return null;
    const saved = agentRecord(JSON.parse(await readFile(join(options.directory, digest(binding.engineId), key, 'runtime.json'), 'utf8')));
    if (saved.accountId !== binding.accountId || saved.profileId !== binding.agentId || saved.revision !== worker.fingerprint
      || saved.applicationInspectionProtocol !== 1 || saved.applicationProtocol !== 1 || saved.candidateVerificationProtocol !== 1 || saved.integrationProtocol !== 1 || saved.workProtocol !== 1 || saved.progressProtocol !== 1 || saved.recoveryProtocol !== 3 || saved.questionProtocol !== 2 || saved.collaborationProtocol !== 1 || saved.historyProtocol !== 1 || saved.decisionProtocol !== 1 || saved.verificationProtocol !== 1 || typeof saved.token !== 'string' || !/^[a-f0-9]{64}$/.test(saved.token)) {
      throw new Error('Start the agent to reconnect collaboration with its current settings.');
    }
    const agent = options.registry.snapshot(binding.workspace).agents.find(a => a.id === binding.agentId);
    const assignment = agent && projectAssignment(agent, binding.workspace);
    if (!agent || !assignment || saved.settingsFingerprint !== runtimeSettingsDigest(agent, binding.workspace, assignment)) {
      throw new Error('Settings changed. Start the agent to resume collaboration.');
    }
    return { externalBusy: worker.externalBusy, connection: { endpoint: worker.endpoint, token: saved.token }, details: await options.management.details(binding.engineId, worker.id) };
  }

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
    return { ...worker, externalBusy: !(raw.ExecIDs === null || Array.isArray(raw.ExecIDs) && raw.ExecIDs.length === 0), fingerprint: labels['ai.cheshi.configuration'] };
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
  async function post(endpoint: string, token: string, route: string, body: unknown, inspection = false) {
    const response = await fetch(`${endpoint}${route}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) }).catch(() => { throw Object.assign(new Error('Delivery outcome is unknown. Inspect the saved worker task.'), { deliveryUncertain: true }); });
    if (inspection && !response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error.slice(0, 2000) : null;
      throw new Error(response.status === 404 ? 'Start the agent to enable this operation.' : message ?? 'Execution inspection failed. The outcome remains unknown.');
    }
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
  async function request(workspaceRoot: string, input: AgentRuntimeRequest, chat?: { roomId: string; conversation: string; goal: boolean; automatic?: true; userText?: string; questionId?: string; inputId?: string }): Promise<AgentRuntimeState> {
    const request = parseAgentRuntimeRequest(input);
    const workspace = await realpath(workspaceRoot);
    const agent = options.registry.snapshot(workspaceRoot).agents.find(item => item.id === request.agentId);
    const assignment = agent && projectAssignment(agent, workspace);
    if (!agent || !assignment) throw new Error('Assign this agent to the current project first.');
    agent.permissions = assignment.permissions ?? agent.permissions;
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
      const dependencies = agent.permissions.commandExecution ? projectDependencies(workspace) : null;
      const settingsFingerprint = runtimeSettingsDigest(agent, workspace, assignment, dependencies);
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
        if (agent.permissions.fileWrite) await (options.checkProjectEnvironment ?? assertProjectEnvironment)(request.engineId, prefix, workspace);
        const environment = !worker || worker.fingerprint !== fingerprint ? await prepareDependencies(run, prefix, image, dependencies) : { image, mounts: [] };
        assertCurrent();
        if (worker && worker.fingerprint !== fingerprint) {
          const details = await options.management.details(request.engineId, worker.id);
          if (worker.externalBusy) throw new Error('Wait for retained container commands before applying settings.');
          if (worker.state === 'running') {
            const previous = agentRecord(JSON.parse(await readFile(configPath, 'utf8')));
            const legacySettings = settingsDigest(agent, workspace, assignment, Number(previous.recoveryProtocol), previous.progressProtocol === 1, previous.workProtocol === 1, previous.integrationProtocol === 1, previous.candidateVerificationProtocol === 1, previous.applicationProtocol === 1, previous.applicationInspectionProtocol === 1, previous.conversationProtocol === 1, previous.activityProtocol === 1, false);
            const legacyRevision = hasFiles ? digest(`${legacySettings}\n${instructions}`) : legacySettings;
            // Upgrade worker control code without changing the execution profile or discarding unknown outcomes.
            // The named volume survives replacement; native results still require explicit inspection.
            const recoveryUpgrade = [1, 2, 3].some(protocol => protocol === previous.recoveryProtocol) && (previous.progressProtocol === undefined || previous.progressProtocol === 1)
              && (previous.workProtocol === undefined || previous.workProtocol === 1) && (previous.integrationProtocol === undefined || previous.integrationProtocol === 1) && (previous.candidateVerificationProtocol === undefined || previous.candidateVerificationProtocol === 1) && (previous.applicationProtocol === undefined || previous.applicationProtocol === 1) && (previous.applicationInspectionProtocol === undefined || previous.applicationInspectionProtocol === 1) && (previous.conversationProtocol === undefined || previous.conversationProtocol === 1) && (previous.activityProtocol === undefined || previous.activityProtocol === 1) && previous.inputQueueProtocol === undefined && previous.settingsFingerprint === legacySettings
              && previous.revision === legacyRevision && worker.fingerprint === legacyRevision
              && previous.accountId === agent.accountId && previous.profileId === agent.id
              && previous.accountFingerprint === selectedAccount && previous.instructions === instructions;
            const executing = details.tasks.some(task => task.status === 'accepted' || task.status === 'running');
            if (!details.ready || details.busy || executing || (details.tasks.some(task => task.status === 'unknown') && !recoveryUpgrade)) throw new Error('Wait for this worker or inspect its unfinished task before applying settings.');
            await run([...prefix, 'container', 'stop', '--time', '15', worker.id]);
          }
          await run([...prefix, 'container', 'rm', worker.id]);
          worker = null; // Preserve the named volume and all conversations/results.
        }
        if (!worker) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const configuration = { accountFingerprint: selectedAccount, revision: fingerprint, settingsFingerprint,
            ...profileConfiguration(agent), permissionProtocol: 1, collaborationProtocol: 1, historyProtocol: 1, decisionProtocol: 1, verificationProtocol: 1, chatsProtocol: 1, recoveryProtocol: 3, questionProtocol: 2, progressProtocol: 1, workProtocol: 1, integrationProtocol: 1, candidateVerificationProtocol: 1, applicationProtocol: 1, applicationInspectionProtocol: 1, conversationProtocol: 1, lifecycleProtocol: 1, eventsProtocol: 1, activityProtocol: 1, inputQueueProtocol: 1, profileId: agent.id, token: randomBytes(32).toString('hex'), instructions };
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
            '--env', 'AGENT_RUNTIME_CONFIG=/agent/runtime.json', '--env', `AGENT_RUNTIME_REVISION=${fingerprint}`, ...environment.mounts, environment.image]);
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
        return { details };
      }
      if (!worker || worker.state !== 'running' || !worker.endpoint) throw new Error('Start this agent first.');
      if (settingsChanged) throw new Error('Settings changed. Start the agent to apply them.');
      const configuration = agentRecord(JSON.parse(await readFile(configPath, 'utf8')));
      if (typeof configuration.token !== 'string' || !/^[a-f0-9]{64}$/.test(configuration.token)) throw new Error('Worker authorization is unavailable.');
      assertCurrent();
      if (chat && configuration.chatsProtocol !== 1) throw new Error('Start the agent to enable Chats.');
      if (request.action === 'question' || request.action === 'question-deadline') {
        await post(worker.endpoint, configuration.token, `/tasks/${request.taskId}/${request.action}`,
          { roomId: request.roomId, questionId: request.questionId,
            ...(request.action === 'question' ? { recipient: request.recipient } : { expiresAt: request.expiresAt }) }, true);
        return { details: await options.management.details(request.engineId, worker.id) };
      }
      if (request.action === 'application-inspect') {
        if (configuration.applicationInspectionProtocol !== 1) throw new Error('Start the agent to enable application inspection.');
        await post(worker.endpoint, configuration.token, `/tasks/${request.taskId}/application`,
          { roomId: request.roomId, candidateId: request.candidateId, hash: request.hash }, true);
        return { details: await options.management.details(request.engineId, worker.id) };
      }
      if (request.action === 'recover') {
        await post(worker.endpoint, configuration.token, `/tasks/${request.taskId}/recover`, { roomId: request.roomId }, true);
        return { details: await options.management.details(request.engineId, worker.id) };
      }
      if (chat?.automatic && configuration.conversationProtocol !== 1) throw new Error('Start the agent to enable conversational tasks.');
      await post(worker.endpoint, configuration.token, chat?.inputId ? `/tasks/${request.taskId}/input` : '/tasks',
        chat?.inputId ? { id: chat.inputId, prompt: request.prompt, roomId: chat.roomId, ...(chat.questionId ? { questionId: chat.questionId } : {}) }
          : { id: request.taskId, prompt: request.prompt, ...(chat ? { chat } : {}) });
      return { details: await options.management.details(request.engineId, worker.id) };
    } catch (error) {
      if (request.action === 'status' && error instanceof DockerCommandError && error.kind === 'engine-unavailable') {
        return { details: null, unavailable: { kind: error.kind, message: error.message } };
      }
      throw error;
    } finally { if (request.action !== 'status') pending.delete(key); }
  }
  function bindingAvailability(workspace: string, agentId: string): AgentRuntimeState | null {
    const agent = options.registry.snapshot(workspace).agents.find(a => a.id === agentId);
    if (!agent) return { details: null, unavailable: { kind: 'agent-removed', message: 'This agent is no longer available. Select another agent.' } };
    if (!projectAssignment(agent, workspace)) return { details: null,
      unavailable: { kind: 'agent-unassigned', message: 'Assign this agent to the current project in Agent settings.' } };
    return null;
  }
  async function status(workspaceRoot: string, parsed: AgentRuntimeRequest): Promise<AgentRuntimeState> {
    const workspace = await realpath(workspaceRoot);
    const unavailable = bindingAvailability(workspace, parsed.agentId);
    if (unavailable) return unavailable;
    try {
      const b = await binding(workspace, parsed), cached = lifecycle.cached(b);
      const result = cached ?? await request(workspace, parsed);
      // Registry deletion or unassignment can finish while Docker status is in flight.
      const changed = bindingAvailability(workspace, parsed.agentId);
      if (changed) return changed;
      const state = lifecycle.state(b);
      return { ...result, ...(state ? { lifecycle: state } : {}) };
    } catch (error) {
      const changed = bindingAvailability(workspace, parsed.agentId);
      if (changed) return changed;
      throw error;
    }
  }
  async function binding(workspaceRoot: string, input: AgentRuntimeRequest) {
    const parsed = parseAgentRuntimeRequest(input), workspace = await realpath(workspaceRoot);
    const agent = options.registry.snapshot(workspaceRoot).agents.find(a => a.id === parsed.agentId && projectAssignment(a, workspace));
    if (!agent) throw new Error('Assign this agent to the current project first.');
    return bindingFor(workspace, parsed.engineId, agent.id, agent.accountId ?? '');
  }
  async function wake(workspace: string, input: AgentRuntimeRequest, retry = false) {
    const b = await binding(workspace, input);
    lifecycle.demand(b);
    const result = await workerOperations.run(() => lifecycle.exclusive(b, async () => {
      if (retry) lifecycle.retry(b);
      await lifecycle.connection(b, true);
      return request(workspace, { ...input, action: 'status' });
    }));
    orchestration.notify(b); changed(b); return result;
  }
  return {
    async permissions(workspaceRoot: string, input: { agentId: string; engineId: string; accountId: string; roomId: string; taskId: string; request: PermissionRequest; decision: 'allow' | 'deny' }) {
      const b = await binding(workspaceRoot, { ...input, action: 'status' });
      if (b.accountId !== input.accountId) throw new Error('The participant account changed.');
      const result = await workerOperations.run(() => lifecycle.exclusive(b, async () => {
        await lifecycle.connection(b, true);
        const state = await request(workspaceRoot, { ...input, action: 'status' });
        const details = state.details, task = details?.tasks.find(t => t.id === input.taskId && t.roomId === input.roomId);
        const current = task?.inspection?.permissionRequest;
        if (!details?.ready || details.busy || details.tasks.some(t => ['accepted', 'running', 'unknown'].includes(t.status))) throw new Error('Wait for this worker or inspect unfinished execution before applying permissions.');
        if (!current || current.id !== input.request.id || current.fileWrite !== input.request.fileWrite || current.commandExecution !== input.request.commandExecution) throw new Error('The permission request changed. Refresh Chats.');
        const desired = input.decision === 'allow' ? 'allowed' : 'denied';
        if (current.status !== 'pending' && current.status !== desired) throw new Error('This permission request was already decided.');
        const snapshot = options.registry.snapshot(workspaceRoot), agent = snapshot.agents.find(a => a.id === input.agentId);
        const assignment = agent && projectAssignment(agent, b.workspace);
        if (!agent || !assignment || agent.accountId !== input.accountId) throw new Error('The participant assignment changed.');
        const permissions = assignment.permissions ?? agent.permissions;
        let grantedRevision: number | undefined;
        if (input.decision === 'allow' && !coversPermissions(permissions, current)) {
          if (current.fileWrite) await (options.checkProjectEnvironment ?? assertProjectEnvironment)(input.engineId, await local(input.engineId), b.workspace);
          const granted = options.registry.save({ id: agent.id, revision: agent.revision, profile: agent, assignment: { ...assignment, assigned: true, permissions: {
            fileWrite: permissions.fileWrite || current.fileWrite, commandExecution: permissions.commandExecution || current.commandExecution,
          } } }, workspaceRoot);
          grantedRevision = granted.snapshot.agents.find(a => a.id === agent.id)!.revision;
        }
        if (input.decision === 'allow') {
          try {
            const started = await request(workspaceRoot, { ...input, action: 'start' });
            if (started.details) lifecycle.adopt(b, started.details);
          } catch (error) {
            const latest = options.registry.snapshot(workspaceRoot).agents.find(a => a.id === agent.id);
            // Restore only this operation's grant; never overwrite a concurrent settings edit.
            if (grantedRevision !== undefined && latest?.revision === grantedRevision) options.registry.save({ id: agent.id, revision: grantedRevision, profile: latest,
              assignment: { ...assignment, assigned: true, permissions: assignment.permissions ?? null } }, workspaceRoot);
            throw error;
          }
        }
        const key = `${agent.id}-${digest(b.workspace).slice(0, 16)}`, prefix = await local(input.engineId);
        const worker = await find(prefix, key);
        if (!worker?.endpoint) throw new Error('Worker is unavailable. Permissions were saved; retry after starting it.');
        const config = agentRecord(JSON.parse(await readFile(join(options.directory, digest(input.engineId), key, 'runtime.json'), 'utf8')));
        if (typeof config.token !== 'string') throw new Error('Worker authorization unavailable.');
        await post(worker.endpoint, config.token, `/tasks/${input.taskId}/permissions`, { roomId: input.roomId, requestId: current.id, decision: input.decision }, true);
        return request(workspaceRoot, { ...input, action: 'status' });
      }));
      orchestration.notify(b); changed(b); return result;
    },
    subscribe(listener: (binding: Binding) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    notify: (binding?: Binding) => orchestration.notify(binding),
    wake,
    lifecycle: (binding: Binding) => lifecycle.state(binding),
    hold: (engine: string, id: string) => lifecycle.hold(engine, id),
    manualControl: <T,>(engine: string, id: string, action: string, operation: () => Promise<T>) =>
      lifecycle.manual(engine, id, action, operation, () => options.management.details(engine, id)),
    chat: async (workspace: string, input: AgentRuntimeRequest, context: { roomId: string; conversation: string; goal: boolean; automatic?: true; userText?: string; questionId?: string; inputId?: string }) => {
      const b = await binding(workspace, input); lifecycle.demand(b);
      const result = await workerOperations.run(() => lifecycle.exclusive(b, () => request(workspace, input, context)));
      orchestration.notify(b); changed(b); return result;
    },
    start() { if (!started) { started = true; unsubscribeRegistry = options.registry.subscribe(() => orchestration.notify()); unsubscribeHistory = options.history?.subscribe?.(() => orchestration.notify()); orchestration.start(); } },
    async dispose() { started = false; unsubscribeRegistry?.(); unsubscribeHistory?.(); await orchestration.dispose(); await lifecycle.settled(); listeners.clear(); },
    request: async (workspaceRoot: string, input: AgentRuntimeRequest) => {
      const parsed = parseAgentRuntimeRequest(input);
      if (parsed.action === 'status') return status(workspaceRoot, parsed);
      if (parsed.action === 'project-setup') {
        await binding(workspaceRoot, parsed);
        const workspace = await realpath(workspaceRoot), prefix = await local(parsed.engineId);
        await workerOperations.exclusive(() => prepareProjectEnvironment(parsed.engineId, prefix, workspace, run));
        return { details: null };
      }
      const b = await binding(workspaceRoot, parsed);
      lifecycle.demand(b);
      const result = await workerOperations.run(() => lifecycle.exclusive(b, async () => {
        if (parsed.action !== 'start' && lifecycle.cached(b)?.lifecycle?.phase === 'sleeping') await lifecycle.connection(b, true);
        const result = await request(workspaceRoot, parsed);
        if (parsed.action === 'start' && result.details) lifecycle.adopt(b, result.details);
        return result;
      }));
      // Never await this tick while holding the per-worker gate: dispatch uses the same gate.
      orchestration.notify(b); changed(b);
      if (parsed.action === 'start') await orchestration.tick();
      return result;
    },
  };
}
function settingsDigest(agent: SpecialistAgent, workspace: string, assignment: SpecialistAgent['assignments'][number], recoveryProtocol = 3, progressProtocol = true, workProtocol = true, integrationProtocol = true, candidateVerificationProtocol = true, applicationProtocol = true, applicationInspectionProtocol = true, conversationProtocol = true, activityProtocol = true, inputQueueProtocol = true) {
  return digest(JSON.stringify({ ...(inputQueueProtocol ? { inputQueueProtocol: 1 } : {}), ...(activityProtocol ? { activityProtocol: 1 } : {}), ...(conversationProtocol ? { conversationProtocol: 1, lifecycleProtocol: 1, eventsProtocol: 1 } : {}), ...(inputQueueProtocol ? { sandboxProtocol: 3, permissionProtocol: 1 } : { sandboxProtocol: 2 }), collaborationProtocol: 1, historyProtocol: 1, decisionProtocol: 1, verificationProtocol: 1, chatsProtocol: 1, recoveryProtocol, questionProtocol: 2, ...(progressProtocol ? { progressProtocol: 1 } : {}), ...(workProtocol ? { workProtocol: 1 } : {}), ...(integrationProtocol ? { integrationProtocol: 1 } : {}), ...(candidateVerificationProtocol ? { candidateVerificationProtocol: 1 } : {}), ...(applicationProtocol ? { applicationProtocol: 1 } : {}), ...(applicationInspectionProtocol ? { applicationInspectionProtocol: 1 } : {}), agent: profileConfiguration({ ...agent, permissions: assignment.permissions ?? agent.permissions }), workspace, instructions: assignment.instructions,
    ...(assignment.instructionFiles?.length ? { instructionFiles: assignment.instructionFiles } : {}) }));
}
function profileConfiguration(agent: SpecialistAgent) {
  return { role: agent.role, accountId: agent.accountId, model: agent.model, reasoningEffort: agent.reasoningEffort,
    serviceTier: agent.serviceTier, permissions: agent.permissions, instructions: agent.instructions,
    ...(agent.instructionFiles?.length ? { instructionFiles: agent.instructionFiles } : {}) };
}

function runtimeSettingsDigest(agent: SpecialistAgent, workspace: string, assignment: SpecialistAgent['assignments'][number], dependencies = (assignment.permissions ?? agent.permissions).commandExecution ? projectDependencies(workspace) : null) {
  return digest(`${settingsDigest(agent, workspace, assignment)}\n${dependencies?.fingerprint ?? ''}`);
}
