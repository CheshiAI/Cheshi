import { execFile } from 'node:child_process';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DockerCommand } from './docker.mts';

export const PROJECT_SETUP_REQUIRED = 'Project setup required:';
export type ColimaCommand = (args: string[]) => Promise<string>;
const colima: ColimaCommand = args => new Promise((resolve, reject) => {
  execFile('/opt/homebrew/bin/colima', args, { timeout: 180_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error('Colima project setup failed. Check the selected VM before retrying.'));
    else resolve(stdout);
  });
});
function profileFor(engine: string, prefix: string[]) {
  if (!engine.startsWith('docker:colima')) return null;
  const profile = engine === 'docker:colima' ? 'default' : engine.slice('docker:colima-'.length);
  if (!/^[a-zA-Z0-9_-]+$/.test(profile) || prefix[0] !== '--host'
    || prefix[1] !== `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`) throw new Error('Colima engine identity does not match its local profile.');
  return profile;
}
export async function assertProjectEnvironment(engine: string, prefix: string[], workspace: string, run: ColimaCommand = colima) {
  const profile = profileFor(engine, prefix);
  if (!profile) return;
  const flags = await run(['--profile', profile, 'ssh', '--', 'findmnt', '--target', workspace, '--noheadings', '--output', 'OPTIONS']);
  if (!flags.trim().split(',').includes('rw')) throw new Error(`${PROJECT_SETUP_REQUIRED} Enable this project's writable Colima share before starting a development worker. Existing containers must be stopped before VM setup.`);
}

/** Narrow edit of Colima's generated block syntax; preserve every unrelated setting. */
export function writableProjectMount(source: string, workspace: string): string {
  if (!workspace.startsWith('/') || /[\r\n\0]/.test(workspace)) throw new Error('Invalid project path.');
  const lines = source.replace(/^mounts:\s*\[\]\s*$/m, 'mounts:').split('\n'), start = lines.findIndex(line => /^mounts:\s*(?:#.*)?$/.test(line));
  if (start < 0) throw new Error('Colima mounts must use a block list. Configure an explicit project mount in Colima first.');
  let end = start + 1;
  while (end < lines.length && !/^[a-zA-Z][\w-]*:/.test(lines[end]!)) end++;
  let found = false;
  for (let i = start + 1; i < end; i++) {
    const match = /^\s+- location:\s*(.*?)\s*$/.exec(lines[i]!);
    if (!match) continue;
    const raw = match[1]!, location = raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw;
    if (location !== workspace) continue;
    if (found) throw new Error('Duplicate project mounts. Resolve the Colima configuration first.');
    found = true;
    let next = i + 1;
    while (next < end && !/^\s+- location:/.test(lines[next]!)) next++;
    const index = lines.findIndex((line, n) => n > i && n < next && /^\s+writable:/.test(line));
    if (index < 0) { lines.splice(i + 1, 0, '    writable: true'); end++; }
    else lines[index] = lines[index]!.replace(/writable:.*/, 'writable: true');
  }
  if (!found) lines.splice(start + 1, 0, `  - location: ${JSON.stringify(workspace)}`, '    writable: true');
  return lines.join('\n');
}

export async function prepareProjectEnvironment(engine: string, prefix: string[], workspace: string, docker: DockerCommand, run: ColimaCommand = colima) {
  const profile = profileFor(engine, prefix);
  if (!profile) throw new Error('Configure the project share in the selected Docker engine. Automatic VM setup supports local Colima profiles.');
  const active = (await docker([...prefix, 'container', 'ls', '--quiet'])).trim();
  if (active) throw new Error('Stop all containers in this Colima profile before project setup. No running task or container was interrupted.');
  const filename = join(homedir(), '.colima', profile, 'colima.yaml');
  if (await realpath(filename) !== filename) throw new Error('Colima configuration must not be a symbolic link.');
  const before = await readFile(filename, 'utf8'), after = writableProjectMount(before, workspace);
  // The caller holds the global worker gate. Recheck external containers immediately before stopping the VM.
  if ((await docker([...prefix, 'container', 'ls', '--quiet'])).trim()) throw new Error('A container started during setup. Stop it and retry.');
  if (await readFile(filename, 'utf8') !== before) throw new Error('Colima settings changed. Retry setup.');
  await run(['--profile', profile, 'stop']);
  const temporary = `${filename}.cheshi.tmp`;
  await writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
  await run(['--profile', profile, 'start']);
  try { await assertProjectEnvironment(engine, prefix, workspace, run); }
  catch {
    // Some Colima versions persist changed mounts on the first boot and apply them on the next.
    if ((await docker([...prefix, 'container', 'ls', '--quiet'])).trim()) throw new Error('Project sharing still needs a restart; a container is now running. Stop it before retrying.');
    await run(['--profile', profile, 'stop']); await run(['--profile', profile, 'start']);
    await assertProjectEnvironment(engine, prefix, workspace, run);
  }
}
