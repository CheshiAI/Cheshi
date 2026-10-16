import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SpecialistAgent } from '../../shared/agent-registry.ts';
import { parseAgentPackage, type AgentPackage } from '../../shared/agent-package.ts';
import { parseHostToolRequest, type HostToolRequest, type HostToolStatus } from '../../shared/host-tools.ts';
import { customToolArguments, type CustomTool } from '../../../experiments/codex-specialists/src/custom-tool-contract.ts';
import { executeHostProcess } from './host-tool-execution.mts';
import { HostToolPolicies, hostToolScopeKey, writeHostToolState, type HostToolScope } from './host-tool-policy.mts';

type Scope = HostToolScope;
interface Grant extends Scope { tool: string; executable: string; executableHash: string; digest: string; id: string; runtime?: string; autoPolicyRevision?: string }
export interface HostToolReview extends Grant { name: string; runtime: string; script: string; output: string; files: string[] }
interface ReviewUi { selectExecutable(runtime: string): Promise<string | null>; confirm(review: HostToolReview): Promise<boolean> }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function executableHash(path: string) {
  await access(path, constants.X_OK);
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
function packDigest(pack: AgentPackage) { return hash(JSON.stringify(pack)); }

/** Grants belong to this installation, never to an exported Homie manifest. */
export class HostToolRegistration {
  private readonly directory: string;
  private readonly snapshot: (workspace: string, id: string) => SpecialistAgent | undefined;
  private readonly active = new Map<string, AbortController>();
  private readonly generations = new Map<string, number>();
  private readonly policies: HostToolPolicies;
  private readonly automaticCalls = new Map<string, string>();
  constructor(directory: string, snapshot: (workspace: string, id: string) => SpecialistAgent | undefined) {
    this.directory = directory; this.snapshot = snapshot;
    this.policies = new HostToolPolicies(directory);
  }
  private definition(workspace: string, id: string, name: string) {
    const root = realpathSync(workspace), agent = this.snapshot(root, id);
    const assignment = agent?.assignments.find(item => { try { return realpathSync(item.workspaceRoot) === root; } catch { return false; } });
    const pack = agent?.package && parseAgentPackage(agent.package), tool = pack?.tools?.find(t => t.name === name);
    if (!agent?.accountId || !assignment || !pack || !tool || tool.execution !== 'host') throw new Error('Save and assign this host tool first.');
    return { agent, pack, tool, scope: { workspace: root, agentId: id, accountId: agent.accountId },
      commandAllowed: (assignment.permissions ?? agent.permissions).commandExecution === true };
  }
  private key(scope: Scope, tool: string) { return hash(JSON.stringify([scope.workspace, scope.agentId, scope.accountId, tool])); }
  private path(key: string) { return join(this.directory, 'grants', `${key}.json`); }
  private grant(key: string): Grant | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')) as Grant; } catch { return null; }
  }
  private invalidate(key: string) {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.active.get(key)?.abort();
  }
  private policyAllows(grant: Grant) {
    if (grant.autoPolicyRevision === undefined) return true;
    const policy = this.policies.read(grant);
    return policy.enabled && policy.revision === grant.autoPolicyRevision;
  }
  private async reusableExecutable(grant: Grant | null, runtime: string) {
    if (!grant || grant.runtime !== runtime) return null;
    try { return await executableHash(grant.executable) === grant.executableHash ? grant.executable : null; }
    catch { return null; }
  }
  async request(workspace: string, request: HostToolRequest, ui?: ReviewUi): Promise<HostToolStatus> {
    request = parseHostToolRequest(request);
    const current = this.definition(workspace, request.agentId, request.tool), key = this.key(current.scope, request.tool);
    const reviewedRevision = current.agent.revision;
    const policy = this.policies.read(current.scope);
    if (request.action === 'policy' && request.autoApprove !== undefined) {
      const changed = this.policies.write(current.scope, request.autoApprove);
      if (changed.revision !== policy.revision) {
        for (const [activeKey, scopeKey] of this.automaticCalls) {
          if (scopeKey === hostToolScopeKey(current.scope)) this.active.get(activeKey)?.abort();
        }
      }
    } else if (request.action === 'revoke') {
      this.invalidate(key);
      if (existsSync(this.path(key))) unlinkSync(this.path(key));
    } else if (request.action === 'allow') {
      if (!ui) throw new Error('Local user review is required.');
      this.invalidate(key);
      const generation = this.generations.get(key);
      const reusable = policy.enabled ? await this.reusableExecutable(this.grant(key), current.tool.runtime) : null;
      const selected = reusable ?? await ui.selectExecutable(current.tool.runtime);
      if (selected) {
        const executable = await realpath(selected), digest = packDigest(current.pack);
        const grant: Grant = { ...current.scope, tool: request.tool, executable, executableHash: await executableHash(executable), digest, id: randomUUID(),
          runtime: current.tool.runtime, ...(policy.enabled ? { autoPolicyRevision: policy.revision! } : {}) };
        const approved = policy.enabled || await ui.confirm({ ...grant, name: current.agent.name, runtime: current.tool.runtime, script: current.tool.script,
          output: join(this.directory, 'runs'), files: current.pack.resources!.files.map(f => f.path) });
        if (approved === true) {
          const checkedHash = await executableHash(executable);
          const fresh = this.definition(workspace, request.agentId, request.tool);
          if (this.generations.get(key) !== generation || fresh.agent.revision !== reviewedRevision
            || this.key(fresh.scope, request.tool) !== key || packDigest(fresh.pack) !== digest
            || this.policies.read(current.scope).revision !== policy.revision
            || checkedHash !== grant.executableHash) throw new Error('Tool changed during review. Review again.');
          writeHostToolState(this.path(key), grant);
        }
      }
    }
    let fresh = this.definition(workspace, request.agentId, request.tool);
    const grant = this.grant(this.key(fresh.scope, request.tool));
    let allowed = false;
    if (grant?.digest === packDigest(fresh.pack)) {
      try {
        const checkedHash = await executableHash(grant.executable);
        fresh = this.definition(workspace, request.agentId, request.tool);
        allowed = checkedHash === grant.executableHash && grant.digest === packDigest(fresh.pack)
          && this.grant(this.key(fresh.scope, request.tool))?.id === grant.id && this.policyAllows(grant);
      } catch { /* Missing, replaced or revoked while checking. */ }
    }
    const latestGrant = this.grant(this.key(fresh.scope, request.tool));
    return { allowed, executable: latestGrant?.executable ?? null, digest: latestGrant?.digest ?? null, autoApprove: this.policies.read(fresh.scope).enabled };
  }
  private async executionGrant(current: ReturnType<HostToolRegistration['definition']>, key: string, ready: () => boolean) {
    const grant = this.grant(key), policy = this.policies.read(current.scope);
    const revision = current.agent.revision;
    if (!grant || (grant.digest === packDigest(current.pack) && this.policyAllows(grant))) return grant;
    if (!policy.enabled || !await this.reusableExecutable(grant, current.tool.runtime)) return grant;
    const fresh = this.definition(current.scope.workspace, current.scope.agentId, current.tool.name);
    if (!ready() || this.grant(key)?.id !== grant.id || this.policies.read(current.scope).revision !== policy.revision
      || fresh.agent.revision !== revision || packDigest(fresh.pack) !== packDigest(current.pack)
      || this.key(fresh.scope, current.tool.name) !== key) throw new Error('Host tool changed during automatic approval.');
    const renewed: Grant = { ...grant, digest: packDigest(current.pack), id: randomUUID(), autoPolicyRevision: policy.revision! };
    writeHostToolState(this.path(key), renewed);
    return renewed;
  }
  async execute(scope: Scope, tool: CustomTool, args: Record<string, unknown>, signal: AbortSignal, valid: () => boolean) {
    signal.throwIfAborted();
    if (!valid()) throw new Error('Host tool permission changed.');
    const current = this.definition(scope.workspace, scope.agentId, tool.name), key = this.key(scope, tool.name);
    if (this.active.has(key)) throw new Error('This host tool already has an active call.');
    if (current.scope.accountId !== scope.accountId || !current.commandAllowed || !current.tool.enabled
      || JSON.stringify(current.tool) !== JSON.stringify(tool)) throw new Error('Allow this version of the host tool in Homie settings first.');
    const input = customToolArguments(tool, args), controller = new AbortController();
    const executionRevision = current.agent.revision;
    this.active.set(key, controller);
    let directory: string | undefined;
    let grant: Grant | null = null;
    const allowed = () => {
      if (!grant || signal.aborted || controller.signal.aborted || !valid() || this.grant(key)?.id !== grant.id) return false;
      try { return this.policyAllows(grant) && this.definition(scope.workspace, scope.agentId, tool.name).agent.revision === executionRevision; } catch { return false; }
    };
    try {
      grant = await this.executionGrant(current, key, () => !signal.aborted && !controller.signal.aborted && valid());
      assertExecutableGrant(grant, packDigest(current.pack), grant !== null && this.policyAllows(grant));
      if (grant.autoPolicyRevision !== undefined) this.automaticCalls.set(key, hostToolScopeKey(scope));
      if (await executableHash(grant.executable) !== grant.executableHash || !allowed()) throw new Error('Host executable or permission changed.');
      const runs = join(this.directory, 'runs'); await mkdir(runs, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(runs, 'call-'));
      const packRoot = join(directory, 'pack'), output = join(directory, 'output'), cache = join(directory, 'cache');
      await mkdir(output, { mode: 0o700 }); await mkdir(cache, { mode: 0o700 });
      for (const file of current.pack.resources!.files) {
        const target = join(packRoot, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.content, { flag: 'wx', mode: 0o400 });
      }
      return await executeHostProcess({ executable: grant.executable, script: join(packRoot, tool.script), cwd: packRoot, output, cache,
        args: input, signal: AbortSignal.any([signal, controller.signal]), valid: allowed });
    } finally {
      this.active.delete(key);
      this.automaticCalls.delete(key);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  dispose() { for (const controller of this.active.values()) controller.abort(); }
}

function assertExecutableGrant(grant: Grant | null, digest: string, policyAllowed: boolean): asserts grant is Grant {
  if (!grant || grant.digest !== digest || !policyAllowed) throw new Error('Allow this version of the host tool in Homie settings first.');
}
