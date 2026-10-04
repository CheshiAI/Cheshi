import type * as FileSystem from 'node:fs';
import { parseApplication } from './application-contract.ts';

export class UnresolvedApplicationError extends Error {
  constructor() {
    super('Unresolved project application. Open the task details and select Inspect application before deleting the worker or saved data.');
    this.name = 'UnresolvedApplicationError';
  }
}

/** Self-contained read-only probe; also serialized into a networkless Docker storage reader. */
export function readApplicationRecords(fs: typeof FileSystem, directory: string) {
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
  const folder = (path: string) => {
    let stat: FileSystem.Stats;
    try { stat = fs.lstatSync(path); }
    catch (error) { if (missing(error)) return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid application storage directory.');
    return true;
  };
  const read = (path: string): unknown => {
    let fd: number;
    try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32_000_000) throw new Error('Invalid application storage record.');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  };
  const root = fs.realpathSync(directory);
  const state = folder(`${root}/state`) ? read(`${root}/state/agent.json`) as { tasks?: { integration?: { id?: unknown; application?: unknown } }[] } | undefined : undefined;
  if (state !== undefined && (!state || !Array.isArray(state.tasks))) throw new Error('Invalid stored task list.');
  const references = (state?.tasks ?? []).flatMap(t => t.integration?.application === undefined ? [] : [t.integration.id]);
  const journals: { candidateId: string; receipt: unknown }[] = [];
  if (folder(`${root}/integrations`)) for (const name of fs.readdirSync(`${root}/integrations`)) {
    if (!folder(`${root}/integrations/${name}`)) throw new Error('Missing integration directory.');
    const receipt = read(`${root}/integrations/${name}/application.json`);
    if (receipt !== undefined) journals.push({ candidateId: name, receipt });
    if (journals.length > 10000) throw new Error('Too many application records to inspect.');
  }
  return { version: 1, references, journals };
}

export function assertApplicationRecords(value: unknown): void {
  const v = value as ReturnType<typeof readApplicationRecords>;
  if (!v || v.version !== 1 || !Array.isArray(v.references) || !Array.isArray(v.journals)) throw new Error('Cannot verify application recovery records.');
  const ids = new Set<string>();
  for (const item of v.journals) {
    const receipt = parseApplication(item.receipt);
    if (item.candidateId !== receipt.candidateId || ids.has(receipt.candidateId)) throw new Error('Application recovery identity is inconsistent.');
    ids.add(receipt.candidateId);
    if (!['applied', 'aborted'].includes(receipt.status) || receipt.lockReleased !== true) {
      throw new UnresolvedApplicationError();
    }
  }
  if (v.references.some(id => typeof id !== 'string' || !ids.has(id))) throw new Error('Application recovery records are missing. Preserve the worker data.');
}
