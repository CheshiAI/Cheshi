import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface HostToolScope { workspace: string; agentId: string; accountId: string }
export interface HostToolPolicy { enabled: boolean; revision: string | null }
export const hostToolScopeKey = (scope: HostToolScope) =>
  createHash('sha256').update(JSON.stringify([scope.workspace, scope.agentId, scope.accountId])).digest('hex');

export function writeHostToolState(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Installation-local policy; never part of a Homie package or its assignments. */
export class HostToolPolicies {
  private readonly directory: string;
  constructor(directory: string) { this.directory = join(directory, 'policies'); }
  read(scope: HostToolScope): HostToolPolicy {
    let content: string;
    try { content = readFileSync(join(this.directory, `${hostToolScopeKey(scope)}.json`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false, revision: null };
      throw error;
    }
    const data = JSON.parse(content) as Partial<HostToolPolicy> | null;
    if (!data || typeof data.enabled !== 'boolean' || typeof data.revision !== 'string' || !data.revision) {
      throw new Error('Invalid local host tool policy.');
    }
    return { enabled: data.enabled === true, revision: data.revision };
  }
  write(scope: HostToolScope, enabled: boolean): HostToolPolicy {
    if (typeof enabled !== 'boolean') throw new Error('Invalid automatic approval setting.');
    const current = this.read(scope);
    if (current.enabled === enabled) return current;
    const policy = { enabled, revision: randomUUID() };
    writeHostToolState(join(this.directory, `${hostToolScopeKey(scope)}.json`), policy);
    return policy;
  }
}
