import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TASK_OUTPUT_MAX_BYTES } from './task-storage-limits.ts';

/** Only the explicitly designated output subtree survives disposable command scratch. */
function validateTree(root: string) {
  const pending = [root];
  let count = 0, bytes = 0;
  while (pending.length) {
    const path = pending.pop()!, stat = lstatSync(path);
    if (++count > 10000 || stat.isSymbolicLink()) throw new Error('Task output contains links or too many entries.');
    if (stat.isDirectory()) pending.push(...readdirSync(path).map(name => join(path, name)));
    else {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Task output must contain ordinary files.');
      bytes += stat.size;
      if (bytes > TASK_OUTPUT_MAX_BYTES) throw new Error('Task output exceeds 1 GiB.');
    }
  }
}

export class TaskOutput {
  readonly directory: string;
  private readonly archive: string;
  constructor(scratch: string, archive: string) {
    this.directory = join(scratch, 'artifacts');
    this.archive = archive;
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    if (!lstatSync(archive).isDirectory() || lstatSync(archive).isSymbolicLink()) throw new Error('Invalid task archive.');
    const pointer = join(archive, 'latest.json');
    if (existsSync(pointer)) {
      const value = JSON.parse(readFileSync(pointer, 'utf8'));
      if (typeof value.snapshot !== 'string' || !/^snapshot-[a-zA-Z0-9]+$/.test(value.snapshot)) throw new Error('Invalid output snapshot.');
      const source = join(archive, value.snapshot);
      validateTree(source);
      cpSync(source, this.directory, { recursive: true, errorOnExist: true, force: false });
    } else mkdirSync(this.directory, { mode: 0o700 });
  }

  preserve() {
    validateTree(this.directory);
    const snapshot = mkdtempSync(join(this.archive, 'snapshot-'));
    cpSync(this.directory, snapshot, { recursive: true });
    const pointer = join(this.archive, `${basename(snapshot)}.json`);
    writeFileSync(pointer, JSON.stringify({ snapshot: basename(snapshot) }), { flag: 'wx', mode: 0o600 });
    renameSync(pointer, join(this.archive, 'latest.json'));
    return snapshot;
  }
}
