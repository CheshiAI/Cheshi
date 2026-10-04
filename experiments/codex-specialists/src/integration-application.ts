import { closeSync, constants, fsyncSync, fstatSync, linkSync as createHardLink, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseApplication, type ApplicationReceipt } from './application-contract.ts';
import { checkedWorkPath, readWorkFile, workDigest } from './work-files.ts';
import type { WorkFile } from './work-contract.ts';

export const APPLICATION_LOCK = '.cheshi-integration-lock';
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readJSON(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64_000) throw new Error('Invalid application journal.');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
/** A journal precedes every mutation. Recovery only inspects; it never replays or rolls back writes. */
export class IntegrationApplication {
  private readonly journal: string;
  private readonly lock: string;
  private readonly workspace: string;
  private readonly baseline: WorkFile[];
  private readonly candidate: WorkFile[];
  private readonly identity: { id: string; candidateId: string; hash: string };
  constructor(directory: string, workspace: string, owner: string, candidateId: string, hash: string, baseline: WorkFile[], candidate: WorkFile[]) {
    this.journal = join(directory, 'application.json'); this.workspace = realpathSync(workspace);
    this.lock = join(this.workspace, APPLICATION_LOCK); this.baseline = baseline; this.candidate = candidate;
    this.identity = { id: workDigest(`application/${owner}/${candidateId}/${hash}`), candidateId, hash };
    if (baseline.some(f => f.path.split('/')[0]?.toLowerCase() === APPLICATION_LOCK)) throw new Error('Application lock path is reserved.');
  }
  private entries(): ApplicationReceipt['files'] {
    return this.candidate.flatMap((file, i) => file.sha256 === this.baseline[i]!.sha256 ? [] : [{ path: file.path, before: this.baseline[i]!.sha256, after: file.sha256, phase: 'pending' as const }]);
  }
  private read(): ApplicationReceipt | null {
    if (!present(this.journal)) return null;
    const receipt = parseApplication(readJSON(this.journal));
    if (receipt.id !== this.identity.id || receipt.candidateId !== this.identity.candidateId || receipt.hash !== this.identity.hash
      || JSON.stringify(receipt.files.map(({ path, before, after }) => ({ path, before, after }))) !== JSON.stringify(this.entries().map(({ path, before, after }) => ({ path, before, after })))) throw new Error('Application journal identity changed.');
    return receipt;
  }
  private save(receipt: ApplicationReceipt): void {
    receipt.updatedAt = new Date().toISOString();
    const temporary = `${this.journal}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(parseApplication(receipt)), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, this.journal); syncDirectory(dirname(this.journal));
  }
  private ownsLock(): boolean {
    if (!present(this.lock)) return false;
    const stat = lstatSync(this.lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid project application lock.');
    return (readJSON(join(this.lock, 'owner.json')) as { id?: unknown })?.id === this.identity.id;
  }
  private release(): void {
    if (!this.ownsLock()) throw new Error('Application lock belongs to another operation.');
    // Staged bytes live under the owned lock, so a crash cannot leave anonymous files in source folders.
    for (const file of this.candidate) {
      const staged = join(this.lock, `stage-${workDigest(file.path)}`);
      if (present(staged)) unlinkSync(staged);
    }
    unlinkSync(join(this.lock, 'owner.json')); rmdirSync(this.lock); syncDirectory(this.workspace);
  }
  private observe(receipt: ApplicationReceipt): ApplicationReceipt {
    const files = receipt.files.map(file => {
      let observed: NonNullable<typeof file.observed>;
      try { const hash = readWorkFile(this.workspace, file.path).sha256; observed = hash === file.after ? 'after' : hash === file.before ? 'before' : 'changed'; }
      catch { observed = 'unavailable'; }
      return { ...file, observed };
    });
    const contextChanged = this.baseline.filter(f => !files.some(c => c.path === f.path)).some(f => {
      try { return readWorkFile(this.workspace, f.path).sha256 !== f.sha256; } catch { return true; }
    });
    const conflict = contextChanged || files.some(f => f.observed === 'changed' || f.observed === 'unavailable');
    const { lockReleased, ...pending } = receipt;
    const status = conflict ? 'conflict' : receipt.status === 'applied' && files.every(f => f.observed === 'after') ? 'applied'
      : receipt.status === 'aborted' && files.every(f => f.observed === 'before') ? 'aborted' : 'interrupted';
    return { ...pending, ...(lockReleased && ['applied', 'aborted'].includes(status) ? { lockReleased } : {}), files, status };
  }
  inspect(): ApplicationReceipt | null {
    const receipt = this.read();
    if (!receipt) return null;
    const observed = this.observe(receipt);
    if (observed.status === 'applied' && present(this.lock) && this.ownsLock()) { observed.status = 'interrupted'; delete observed.lockReleased; }
    return observed;
  }
  private assertExpected(receipt: ApplicationReceipt): void {
    for (const before of this.baseline) {
      const entry = receipt.files.find(f => f.path === before.path);
      const expected = entry?.phase === 'written' ? entry.after : before.sha256;
      if (readWorkFile(this.workspace, before.path).sha256 !== expected) throw new Error(`Project changed during application: ${before.path}`);
    }
  }
  apply(verificationId: string): ApplicationReceipt {
    const existing = this.inspect();
    if (existing) return existing; // Never replay an interrupted attempt, including after a lost acknowledgement.
    const receipt: ApplicationReceipt = { ...this.identity, verificationId, status: 'applying', updatedAt: new Date().toISOString(), files: this.entries() };
    this.assertExpected(receipt);
    if (present(this.lock)) throw new Error('Project application lock already exists.');
    this.save(receipt); // Durable intent also protects a crash before lock acquisition.
    mkdirSync(this.lock, { mode: 0o700 }); // Shared across workers; a stale lock requires explicit inspection by its owner.
    writeFileSync(join(this.lock, 'owner.json'), JSON.stringify(this.identity), { flag: 'wx', mode: 0o600, flush: true });
    syncDirectory(this.lock); syncDirectory(this.workspace);
    try {
      for (const entry of receipt.files) {
        this.assertExpected(receipt); entry.phase = 'writing'; this.save(receipt);
        const target = checkedWorkPath(this.workspace, entry.path), after = this.candidate.find(f => f.path === entry.path)!;
        const mode = entry.before === null ? 0o644 : lstatSync(target).mode & 0o777;
        if (entry.before !== null && lstatSync(target).nlink !== 1) throw new Error('Linked project files cannot be replaced.');
        if (after.content === null) { this.assertExpected(receipt); unlinkSync(target); syncDirectory(dirname(target)); }
        else {
          mkdirSync(dirname(target), { recursive: true }); checkedWorkPath(this.workspace, entry.path);
          const temporary = join(this.lock, `stage-${workDigest(entry.path)}`);
          let created = false;
          try {
            writeFileSync(temporary, after.content, { flag: 'wx', mode, flush: true }); created = true; syncDirectory(this.lock);
            this.assertExpected(receipt); checkedWorkPath(this.workspace, entry.path);
            if (entry.before === null) { createHardLink(temporary, target); unlinkSync(temporary); }
            else renameSync(temporary, target);
            syncDirectory(dirname(target));
          } finally { if (created && present(temporary)) unlinkSync(temporary); }
        }
        entry.phase = 'written'; this.save(receipt);
      }
      this.assertExpected(receipt); receipt.status = 'applied'; this.save(receipt); this.release();
      receipt.lockReleased = true; this.save(receipt);
      return this.observe(receipt);
    } catch (error) {
      delete receipt.lockReleased; receipt.status = 'interrupted'; this.save(receipt);
      throw error; // Keep the lock and journal. Never restore over another writer's changes.
    }
  }
  recover(): ApplicationReceipt {
    const saved = this.read();
    if (!saved) throw new Error('No application receipt to inspect.');
    const observed = this.observe(saved);
    const locked = present(this.lock);
    if (locked && !this.ownsLock()) throw new Error('Application lock belongs to another operation.');
    if (observed.status !== 'conflict') {
      if (observed.files.every(f => f.observed === 'after' && f.phase !== 'pending')) {
        observed.status = 'applied'; observed.files.forEach(f => { f.phase = 'written'; });
      } else if (observed.files.every(f => f.observed === 'before')) observed.status = 'aborted';
    }
    this.save(observed);
    if (observed.status === 'applied' || observed.status === 'aborted') {
      if (locked) this.release();
      observed.lockReleased = true; this.save(observed);
    }
    return observed;
  }
}
