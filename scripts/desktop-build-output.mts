import { mkdir, access, rmdir, readFile, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ownerFile = '.build-owner.json';
export interface BuildOwner { version: 1; token: string; pid: number; groups: number[] }
export interface BuildOutput { name: string; staging: string; destination: string; owner: BuildOwner }

export function buildProcessExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export async function saveBuildOwner(output: BuildOutput): Promise<void> {
  const temporary = join(output.staging, `${ownerFile}.${output.owner.token}.tmp`);
  await writeFile(temporary, JSON.stringify(output.owner));
  await rename(temporary, join(output.staging, ownerFile));
}

async function readOwner(staging: string): Promise<BuildOwner | null> {
  try {
    if (!(await lstat(staging)).isDirectory()) return null;
    const value = JSON.parse(await readFile(join(staging, ownerFile), 'utf8')) as Partial<BuildOwner>;
    return value.version === 1 && typeof value.token === 'string' && /^[\da-f-]{36}$/.test(value.token)
      && Number.isSafeInteger(value.pid) && value.pid! > 0 && Array.isArray(value.groups)
      && value.groups.every(pid => Number.isSafeInteger(pid) && pid !== 0) ? value as BuildOwner : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Delete only this reservation, after every recorded writer has stopped. */
export async function discardBuildOutput(output: BuildOutput): Promise<void> {
  const owner = await readOwner(output.staging);
  if (!owner || owner.token !== output.owner.token) {
    if (!await exists(output.staging)) return;
    throw new Error(`Build ownership could not be verified: ${output.staging}`);
  }
  if (owner.groups.some(buildProcessExists)) throw new Error(`Build processes are still using ${output.staging}`);
  await rm(output.staging, { recursive: true, force: true });
}

/** Unknown/legacy directories and live owners are never guessed to be disposable. */
export async function recoverAbandonedBuilds(out: string): Promise<string[]> {
  await mkdir(out, { recursive: true });
  const removed: string[] = [];
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.building-\d{8}-\d{6}(?:-\d{4})?$/.test(entry.name)) continue;
    const staging = join(out, entry.name);
    const owner = await readOwner(staging);
    if (!owner || buildProcessExists(owner.pid) || owner.groups.some(buildProcessExists)) continue;
    const name = entry.name.slice('.building-'.length);
    await discardBuildOutput({ name, staging, destination: join(out, name), owner });
    removed.push(staging);
  }
  return removed;
}

export function buildTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${value('year')}${value('month')}${value('day')}-${value('hour')}${value('minute')}${value('second')}`;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Atomic staging reservation protects previous builds and concurrent invocations. */
export async function reserveBuildOutput(out: string, date = new Date()): Promise<BuildOutput> {
  await mkdir(out, { recursive: true });
  const timestamp = buildTimestamp(date);
  for (let sequence = 0; sequence < 10_000; sequence++) {
    const name = `${timestamp}${sequence ? `-${String(sequence).padStart(4, '0')}` : ''}`;
    const destination = join(out, name), staging = join(out, `.building-${name}`);
    if (await exists(destination)) continue;
    try {
      await mkdir(staging);
      // A previous owner may have finished between our existence check and mkdir.
      if (await exists(destination)) { await rmdir(staging); continue; }
      const output: BuildOutput = { name, staging, destination,
        owner: { version: 1, token: randomUUID(), pid: process.pid, groups: [] } };
      try { await saveBuildOwner(output); }
      catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
      return output;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new Error('No unused build output name is available.');
}

export async function completeBuildOutput(output: BuildOutput): Promise<void> {
  await rename(output.staging, output.destination);
  await rm(join(output.destination, ownerFile), { force: true });
}

export const finderBuildRevealScript = `on run argv
  set buildFolder to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    reveal buildFolder
    activate
    return (selection as alias list) is {buildFolder}
  end tell
end run`;
