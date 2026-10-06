import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareDependencies, projectDependencies } from '../lib/agent-management/dependencies.mts';
import { prepareSpecialistWorker } from '../../scripts/prepare-specialist-worker.mts';

const execute = promisify(execFile), context = process.env.CHESHI_CODEGRAPH_DOCKER_CONTEXT;
test.if(Boolean(context))('Docker seeds Linux dependency volumes once and reuses them with a different worker image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-dependency-test-')), prefix = ['--context', context!];
  const name = `cheshi-dependency-test-${randomUUID()}`, environment = `${name}:environment`, upgraded = `${name}:worker`;
  const images = new Set<string>(), volumes = new Set<string>();
  let dependencyBuilds = 0;
  const docker = async (args: string[]) => (await execute('docker', args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const run = async (args: string[]) => {
    if (args.includes('--tag')) { images.add(args[args.indexOf('--tag') + 1]!); dependencyBuilds++; }
    for (const arg of args) if (arg.startsWith('type=volume,')) volumes.add(/src=([^,]+)/.exec(arg)![1]!);
    return docker(args);
  };
  try {
    const build = join(root, 'build'), project = join(root, 'project');
    mkdirSync(project); mkdirSync(join(project, 'frontend'));
    await prepareSpecialistWorker(fileURLToPath(new URL('../../experiments/codex-specialists', import.meta.url)), build);
    await docker([...prefix, 'build', '--target', 'specialist-environment', '--tag', environment, build]); images.add(environment);
    writeFileSync(join(build, 'Dockerfile'), `${readFileSync(join(build, 'Dockerfile'), 'utf8')}\nCOPY worker-version /app/worker-version\n`);
    writeFileSync(join(build, 'worker-version'), 'new worker code');
    await docker([...prefix, 'build', '--tag', upgraded, build]); images.add(upgraded);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name, workspaces: ['frontend'], dependencies: { fixture: 'workspace:*' } }));
    writeFileSync(join(project, 'frontend/package.json'), '{"name":"fixture","version":"1.0.0"}');
    await execute('bun', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: project, timeout: 15_000 });
    const plan = projectDependencies(project);
    const first = await prepareDependencies(run, prefix, environment, plan, environment);
    const second = await prepareDependencies(run, prefix, upgraded, plan, environment);
    expect(dependencyBuilds).toBe(1); expect(second.image).toBe(upgraded); expect(second.mounts).toEqual(first.mounts);
    const result = await docker([...prefix, 'run', '--rm', '--network', 'none', '--read-only', ...second.mounts, second.image,
      'bun', '-e', "const fs=require('node:fs');console.log(JSON.stringify({dependency:fs.lstatSync('/workspace/node_modules/fixture').isSymbolicLink(),worker:fs.readFileSync('/app/worker-version','utf8')}));"]);
    expect(JSON.parse(result)).toEqual({ dependency: true, worker: 'new worker code' });
  } finally {
    for (const volume of volumes) await docker([...prefix, 'volume', 'rm', volume]);
    for (const image of [...images].reverse()) await docker([...prefix, 'image', 'rm', image]);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
