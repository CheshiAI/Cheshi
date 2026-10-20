import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { product } from '../config/product.mts';
import { finderBuildRevealScript } from './desktop-build-output.mts';
import { BuildInterruptedError, withDesktopBuild } from './desktop-build-lifecycle.mts';
import { localSigningEnvironment, verifyMacOSBuildSignature } from './macos-build-signing.mts';

const root = fileURLToPath(new URL('..', import.meta.url));
const flags = process.argv.slice(2);
if (flags.some(flag => flag !== '--no-finder')) throw new Error('Usage: bun run desktop:package [--no-finder]');
try {
  Object.assign(process.env, localSigningEnvironment(process.env, process.platform));
  const { output, value: appRelative } = await withDesktopBuild({
    out: join(root, 'out'), cwd: root,
    onRecovered: path => console.log(`[build] Removed abandoned staging: ${path}`),
    onDiscarded: path => console.log(`[build] Removed failed staging: ${path}`),
    build: async (output, run) => {
      console.log(`[build] Preparing ${output.name} (Asia/Seoul)`);
      console.log('[build] Checking packaged runtime imports');
      await run(['node', '--test', '--test-name-pattern=packages every relative runtime import', 'desktop/test/config-runtime.test.ts']);
      for (const task of ['desktop:ghostty', 'viewer:build', 'desktop:runtime']) await run([process.execPath, 'run', task]);
      await run([process.execPath, 'x', '--no-install', 'electron-forge', 'package']);
      const bundleName = `${product.displayName}-${process.platform}-${process.arch}`;
      const appRelative = process.platform === 'darwin' ? join(bundleName, `${product.displayName}.app`) : bundleName;
      const app = join(output.staging, appRelative);
      const resources = process.platform === 'darwin' ? join(app, 'Contents', 'Resources') : join(app, 'resources');
      for (const file of ['app.asar', 'dist/index.html', `runtime/${process.platform}-${process.arch}/cheshi-cli`]) {
        await access(join(resources, file));
      }
      const signing = process.platform === 'darwin' ? verifyMacOSBuildSignature(app, product.bundleId) : undefined;
      const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      if (git.exitCode !== 0) throw new Error('Unable to record build revision.');
      const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      if (status.exitCode !== 0) throw new Error('Unable to record build worktree state.');
      await writeFile(join(output.staging, 'build.json'), JSON.stringify({
        builtAt: new Date().toISOString(), timeZone: 'Asia/Seoul', version: product.version, buildNumber: product.buildNumber,
        revision: git.stdout.toString().trim(), dirty: status.stdout.length > 0, platform: process.platform, arch: process.arch,
        ...(signing ? { signing } : {}),
        app: appRelative, asarSha256: createHash('sha256').update(await readFile(join(resources, 'app.asar'))).digest('hex'),
      }, null, 2) + '\n');
      return appRelative;
    },
  });
  console.log(`[build] App: ${join(output.destination, appRelative)}`);
  if (process.platform === 'darwin' && !flags.includes('--no-finder')) {
    const result = Bun.spawnSync(['/usr/bin/osascript', '-e', finderBuildRevealScript, output.destination],
      { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    if (result.exitCode === 0 && result.stdout.toString().trim() === 'true') console.log('[build] Finder: new build folder selected.');
    else console.warn(`[build] App built; Finder could not select the build folder: ${result.stderr.toString().trim()}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = error instanceof BuildInterruptedError ? error.exitCode : 1;
}
