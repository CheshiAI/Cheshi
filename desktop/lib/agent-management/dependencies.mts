import { createHash } from 'node:crypto';
import { globSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { DockerCommand } from './docker.mts';

export interface ProjectDependencies { workspace: string; fingerprint: string; files: { path: string; content: string }[]; directories: string[] }
/** Only manifests enter the preparation image. Never copy host dependencies or credentials. */
export function projectDependencies(workspace: string): ProjectDependencies | null {
  if (!existsSync(join(workspace, 'package.json'))) return null;
  if (!existsSync(join(workspace, 'bun.lock'))) throw new Error('Project dependencies need a committed bun.lock before running commands in Linux.');
  const root = realpathSync(workspace), files: ProjectDependencies['files'] = [];
  function read(name: string) {
    const target = realpathSync(join(root, name)), path = relative(root, target);
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('Dependency manifests must stay inside the project.');
    const content = readFileSync(target, 'utf8');
    if (content.length > 8_000_000) throw new Error('Dependency manifest is too large.');
    files.push({ path: name, content }); return content;
  }
  const manifest = JSON.parse(read('package.json')) as Record<string, unknown>;
  read('bun.lock');
  if (existsSync(join(root, 'bunfig.toml'))) {
    const config = read('bunfig.toml');
    const install = /^\[install\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(config)?.[1] ?? '';
    const linker = /^\s*linker\s*=\s*["'](hoisted|isolated)["']\s*$/m.exec(install)?.[1];
    // Keep install layout, but never copy registry credentials or executable preloads.
    files.find(f => f.path === 'bunfig.toml')!.content = linker ? `[install]\nlinker = "${linker}"\n` : '';
  }
  if (manifest.patchedDependencies) throw new Error('Patched dependencies require a prepared Linux environment; automatic setup will not copy patch sources.');
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces as { packages?: unknown } | undefined)?.packages ?? [];
  if (!Array.isArray(workspaces)) throw new Error('Invalid workspace manifests.');
  const directories = new Set<string>(['node_modules']);
  for (const pattern of workspaces) {
    if (typeof pattern !== 'string' || isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw new Error('Workspace dependency paths must stay inside the project.');
    for (const filename of globSync(`${pattern}/package.json`, { cwd: root })) {
      if (files.length >= 1000) throw new Error('Too many workspace manifests.');
      if (files.some(f => f.path === filename)) continue;
      if (/[,\r\n]/.test(filename)) throw new Error('Workspace paths cannot contain Docker mount separators.');
      read(filename); directories.add(`${dirname(filename)}/node_modules`);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // Dependencies outside these manifests need source files and must not be fetched from host paths.
  for (const file of files.filter(f => f.path.endsWith('package.json'))) {
    const value = JSON.parse(file.content) as Record<string, unknown>;
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const spec of Object.values((value[key] ?? {}) as Record<string, unknown>)) {
        if (typeof spec === 'string' && (/^(file:|link:|\.\.?\/|\/)/.test(spec) || /https?:\/\/[^/]*@/.test(spec))) throw new Error('Local-path or credential-bearing dependencies require explicit environment setup.');
      }
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { workspace: root, fingerprint, files, directories: [...directories].sort() };
}

export async function prepareDependencies(run: DockerCommand, prefix: string[], baseImage: string, plan: ProjectDependencies | null, environmentImage: string) {
  if (!plan) return { image: baseImage, mounts: [] as string[] };
  const platform = (await run([...prefix, 'info', '--format', '{{.OSType}}/{{.Architecture}}'])).trim();
  if (!platform.startsWith('linux/')) throw new Error('A Linux Docker engine is required.');
  const base = (await run([...prefix, 'image', 'inspect', environmentImage, '--format', '{{.Id}}'])).trim();
  const key = createHash('sha256').update(`3/${platform}/${base}/${plan.fingerprint}`).digest('hex').slice(0, 32);
  const image = `cheshi-project-deps:${key}`;
  const existing = (await run([...prefix, 'image', 'ls', '--quiet', image])).trim();
  if (!existing) {
    const context = await mkdtemp(join(tmpdir(), 'cheshi-linux-deps-'));
    try {
      for (const file of plan.files) {
        const target = join(context, 'manifests', file.path);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content, { mode: 0o600 });
      }
      const folders = JSON.stringify(plan.directories);
      const prepare = `for(const p of ${folders})require('node:fs').mkdirSync(p,{recursive:true});`;
      const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      await writeFile(join(context, 'Dockerfile'), `FROM ${environmentImage}\nUSER root\nRUN mkdir -p /workspace /home/node/dependency-tmp /home/node/dependency-cache && chown -R node:node /workspace /home/node/dependency-tmp /home/node/dependency-cache\nCOPY --chown=node:node manifests/ /workspace/\nUSER node\nWORKDIR /workspace\nRUN TMPDIR=/home/node/dependency-tmp BUN_INSTALL_CACHE_DIR=/home/node/dependency-cache bun install --frozen-lockfile --ignore-scripts && bun -e ${quote(prepare)}\nWORKDIR /app\n`);
      await run([...prefix, 'build', '--tag', image, context]);
    } finally { await rm(context, { recursive: true, force: true }); }
  }
  // Docker cannot create nested mountpoints through a read-only host bind.
  // These are empty generated directories, never host dependency installations.
  for (const directory of plan.directories) {
    const target = join(plan.workspace, directory);
    const parent = relative(plan.workspace, realpathSync(dirname(target)));
    if (parent.startsWith('..') || isAbsolute(parent)) throw new Error('Dependency mountpoint parents must stay inside the project.');
    if (!existsSync(target)) await mkdir(target);
    const resolved = relative(plan.workspace, realpathSync(target));
    if (resolved.startsWith('..') || isAbsolute(resolved)) throw new Error('Dependency mountpoints must stay inside the project.');
  }
  // Seed dependency volumes independently of the worker image. Code-only worker
  // upgrades reuse these volumes; manifests or the execution environment invalidate them.
  const mounts = plan.directories.flatMap((directory, index) => ['--mount', `type=volume,src=cheshi-deps-${key}-${index},dst=/workspace/${directory},readonly`]);
  await run([...prefix, 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--user', '1000:1000', ...mounts, image, 'bun', '-e', '']);
  return { image: baseImage, mounts };
}
