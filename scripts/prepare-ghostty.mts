import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_STAMP_VERSION = 2;
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeDirectory = path.join(rootDirectory, 'desktop', 'native', 'ghostty-bridge');
const bridgeBuildDirectory = path.join(bridgeDirectory, '.build');
const addonDirectory = path.join(rootDirectory, 'desktop', 'native', 'electron-libghostty');
const addonDependencyDirectory = path.join(addonDirectory, 'native-deps', 'lib');
const runtimeDirectory = path.join(rootDirectory, 'desktop', 'lib', 'electron-libghostty', 'native');
const addonOutput = path.join(addonDirectory, 'build', 'Release', 'cheshi_ghostty.node');
const runtimeAddon = path.join(runtimeDirectory, 'cheshi_ghostty.node');
const runtimeLibrary = path.join(runtimeDirectory, 'libCheshiGhosttyBridge.dylib');
const buildStamp = path.join(runtimeDirectory, 'build-stamp.json');
const defaultXcodeDeveloperDirectory = '/Applications/Xcode.app/Contents/Developer';
const developerDirectory = process.env.DEVELOPER_DIR
  || (existsSync(defaultXcodeDeveloperDirectory) ? defaultXcodeDeveloperDirectory : undefined);
const moduleCacheDirectory = path.join(bridgeBuildDirectory, 'module-cache');
const buildEnvironment = {
  ...process.env,
  ...(developerDirectory ? { DEVELOPER_DIR: developerDirectory } : {}),
  CLANG_MODULE_CACHE_PATH: moduleCacheDirectory,
  SWIFTPM_MODULECACHE_OVERRIDE: moduleCacheDirectory,
};
const nodeGyp = path.join(rootDirectory, 'node_modules', '@electron', 'node-gyp', 'bin', 'node-gyp.js');
const nodeCommand = process.env.CHESHI_NODE?.trim() || 'node';
const buildInputs = [
  path.join(bridgeDirectory, 'Package.swift'),
  path.join(bridgeDirectory, 'Package.resolved'),
  path.join(bridgeDirectory, 'Sources'),
  path.join(addonDirectory, 'binding.gyp'),
  path.join(addonDirectory, 'include'),
  path.join(addonDirectory, 'src'),
  path.join(rootDirectory, 'node_modules', 'node-addon-api', 'package.json'),
  path.join(rootDirectory, 'node_modules', '@electron', 'node-gyp', 'package.json'),
  path.join(rootDirectory, 'node_modules', 'electron', 'package.json'),
];

interface RunOptions {
  quiet?: boolean;
}

function filterToolOutput(value: string | Buffer | null | undefined): string {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => line && !/^gyp (?:sill|verb)\b/.test(line))
    .join('\n');
}

function run(
  command: string,
  args: string[],
  cwd: string = rootDirectory,
  { quiet = false }: RunOptions = {},
): void {
  const result = spawnSync(command, args, {
    cwd,
    env: buildEnvironment,
    ...(quiet
      ? { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      : { stdio: 'inherit' }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (quiet) {
      const stdout = filterToolOutput(result.stdout);
      const stderr = filterToolOutput(result.stderr);
      if (stdout) process.stdout.write(`${stdout}\n`);
      if (stderr) process.stderr.write(`${stderr}\n`);
    }
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function signAdHoc(filePath: string): void {
  run('/usr/bin/codesign', ['--force', '--sign', '-', filePath], rootDirectory, { quiet: true });
  run('/usr/bin/codesign', ['--verify', '--strict', filePath], rootDirectory, { quiet: true });
}

function findFile(directory: string, filename: string): string | null {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.endsWith('.dSYM')) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return null;
}

function updateFingerprint(hash: Hash, candidate: string): void {
  const relativePath = path.relative(rootDirectory, candidate);
  if (!existsSync(candidate)) {
    hash.update(`${relativePath}\0missing\0`);
    return;
  }
  const stats = statSync(candidate);
  if (stats.isDirectory()) {
    hash.update(`${relativePath}\0directory\0`);
    for (const entry of readdirSync(candidate).sort()) {
      updateFingerprint(hash, path.join(candidate, entry));
    }
    return;
  }
  if (!stats.isFile()) return;
  hash.update(`${relativePath}\0file\0`);
  hash.update(readFileSync(candidate));
  hash.update('\0');
}

function commandVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    env: buildEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return 'unavailable';
  return String(result.stdout || result.stderr || '').trim();
}

function sourceFingerprint(): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    version: BUILD_STAMP_VERSION,
    platform: process.platform,
    architecture: process.arch,
    node: commandVersion(nodeCommand, ['--version']),
    swift: commandVersion('/usr/bin/xcrun', ['swift', '--version']),
    developerDirectory: developerDirectory ?? null,
  }));
  for (const candidate of buildInputs) updateFingerprint(hash, candidate);
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outputIsCurrent(fingerprint: string): boolean {
  if (!existsSync(runtimeAddon) || !existsSync(runtimeLibrary) || !existsSync(buildStamp)) return false;
  try {
    const saved: unknown = JSON.parse(readFileSync(buildStamp, 'utf8'));
    return isRecord(saved)
      && saved.version === BUILD_STAMP_VERSION
      && saved.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

if (process.platform !== 'darwin') {
  process.stdout.write('Ghostty native surfaces are available on macOS only; skipping native build.\n');
  process.exit(0);
}

if (!existsSync(nodeGyp)) {
  throw new Error('Electron node-gyp is not installed. Run bun install first.');
}
if (!existsSync(path.join(rootDirectory, 'node_modules', 'node-addon-api', 'package.json'))) {
  throw new Error('node-addon-api is not installed. Run bun install first.');
}

const fingerprint = sourceFingerprint();
// These obsolete build artifacts must not travel with the renamed native runtime.
for (const legacyArtifact of [
  path.join(runtimeDirectory, 'studio_ghostty.node'),
  path.join(runtimeDirectory, 'libStudioGhosttyBridge.dylib'),
  path.join(addonDependencyDirectory, 'libStudioGhosttyBridge.dylib'),
]) {
  rmSync(legacyArtifact, { force: true });
}
if (process.env.CHESHI_REBUILD_GHOSTTY !== '1' && outputIsCurrent(fingerprint)) {
  process.stdout.write(`Cheshi Ghostty native surface bridge is current (${Math.round(performance.now())} ms).\n`);
  process.exit(0);
}

process.stdout.write('Building Cheshi Ghostty native surface bridge…\n');
mkdirSync(moduleCacheDirectory, { recursive: true });
run('/usr/bin/xcrun', [
  'swift',
  'build',
  '--package-path', bridgeDirectory,
  '--scratch-path', bridgeBuildDirectory,
  '--configuration', 'release',
  '--product', 'CheshiGhosttyBridge',
]);

const bridgeLibrary = findFile(bridgeBuildDirectory, 'libCheshiGhosttyBridge.dylib');
if (!bridgeLibrary) throw new Error('Swift build did not produce libCheshiGhosttyBridge.dylib.');

mkdirSync(addonDependencyDirectory, { recursive: true });
const addonLibrary = path.join(addonDependencyDirectory, 'libCheshiGhosttyBridge.dylib');
copyFileSync(bridgeLibrary, addonLibrary);

run(nodeCommand, [nodeGyp, 'rebuild'], addonDirectory, { quiet: true });
if (!existsSync(addonOutput)) throw new Error('Native build did not produce cheshi_ghostty.node.');

mkdirSync(runtimeDirectory, { recursive: true });
copyFileSync(addonOutput, runtimeAddon);
copyFileSync(addonLibrary, runtimeLibrary);
signAdHoc(runtimeLibrary);
signAdHoc(runtimeAddon);
writeFileSync(buildStamp, `${JSON.stringify({
  version: BUILD_STAMP_VERSION,
  fingerprint,
})}\n`, 'utf8');
process.stdout.write(`Cheshi Ghostty native surface bridge ready: ${runtimeAddon}\n`);
process.stdout.write(`[cheshi] Native bridge preparation: ${Math.round(performance.now())} ms\n`);
