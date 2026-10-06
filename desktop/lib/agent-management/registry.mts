import { randomAgentAvatar } from '../../shared/agent-avatar.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { workerOperations } from './operations.mts';
import { parseDeleteSpecialistAgent, parseSaveSpecialistAgent, parseSpecialistAgents } from '../../shared/agent-registry.ts';
import type { AgentRegistrySnapshot, SpecialistAgent } from '../../shared/agent-registry.ts';

const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
function assertRegistrySize(bytes: number): void {
  if (bytes > MAX_REGISTRY_BYTES) throw new Error('Agent registry exceeds its storage limit.');
}

/** One main-process registry shared by workspace windows; credentials remain in account storage. */
export function createAgentRegistry(filename: string) {
  const listeners = new Set<() => void>();
  function read(): SpecialistAgent[] {
    let content: string;
    try { assertRegistrySize(statSync(filename).size); content = readFileSync(filename, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('agents' in data)) {
      throw new Error('Unsupported agent registry. The saved file has not been changed.');
    }
    return parseSpecialistAgents(data.agents);
  }
  function root(workspaceRoot: string): string {
    if (!path.isAbsolute(workspaceRoot)) throw new Error('An absolute workspace path is required.');
    return path.resolve(workspaceRoot);
  }
  function snapshot(workspaceRoot: string): AgentRegistrySnapshot { return { agents: read(), workspaceRoot: root(workspaceRoot) }; }
  function write(next: SpecialistAgent[]) {
    const serialized = `${JSON.stringify({ version: 1, agents: next }, null, 2)}\n`;
    assertRegistrySize(Buffer.byteLength(serialized));
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, filename);
    } finally {
      try { rmSync(temporary, { force: true }); }
      catch (error) { console.error('[cheshi] Agent registry temporary file cleanup failed:', error); }
    }
    for (const listener of listeners) {
      try { listener(); } catch (error) { console.error('[cheshi] Agent registry subscriber failed:', error); }
    }
  }
  return {
    snapshot,
    remove(value: unknown, workspaceRoot: string) {
      const input = parseDeleteSpecialistAgent(value), workspace = root(workspaceRoot), agents = read();
      const previous = agents.find(agent => agent.id === input.id);
      if (!previous || previous.revision !== input.revision) throw new Error('This agent changed. Reopen its settings before deleting.');
      const next = agents.filter(agent => agent.id !== input.id);
      write(next);
      return { agents: next, workspaceRoot: workspace };
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save(value: unknown, workspaceRoot: string) {
      workerOperations.assertAvailable();
      const input = parseSaveSpecialistAgent(value), workspace = root(workspaceRoot), agents = read();
      const previous = input.id ? agents.find(agent => agent.id === input.id) : undefined;
      if (input.id && (!previous || previous.revision !== input.revision)) {
        throw new Error('This agent was changed in another window. Reopen its settings before saving.');
      }
      if (agents.some(agent => agent.id !== input.id && agent.name.toLocaleLowerCase() === input.profile.name.toLocaleLowerCase())) {
        throw new Error('An agent with this name already exists.');
      }
      const now = new Date().toISOString();
      const assignments = (previous?.assignments ?? []).filter(item => item.workspaceRoot !== workspace);
      const previousAssignment = previous?.assignments.find(item => item.workspaceRoot === workspace);
      const permissions = input.assignment.permissions === undefined ? previousAssignment?.permissions : input.assignment.permissions;
      const projectFiles = input.assignment.instructionFiles ?? previous?.assignments.find(item => item.workspaceRoot === workspace)?.instructionFiles;
      if (input.assignment.assigned) assignments.push({ ...(permissions ? { permissions } : {}), workspaceRoot: workspace, instructions: input.assignment.instructions,
        ...(projectFiles === undefined ? {} : { instructionFiles: projectFiles }) });
      const agent: SpecialistAgent = { ...input.profile, package: input.profile.package ?? previous?.package, instructionFiles: input.profile.instructionFiles ?? previous?.instructionFiles,
        avatar: input.profile.avatar ?? previous?.avatar ?? randomAgentAvatar(), id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now, updatedAt: now, assignments };
      const next = parseSpecialistAgents([...agents.filter(item => item.id !== agent.id), agent]);
      write(next);
      return { agentId: agent.id, snapshot: { agents: next, workspaceRoot: workspace } };
    },
  };
}
