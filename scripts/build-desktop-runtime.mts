import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_LANGUAGE_SERVER_PACKAGES } from '../desktop/lib/language-server-runtime.mts';
import { buildDesktopPreload } from './build-desktop-preload.mts';
import { buildAppleCalendar } from './build-apple-calendar.mts';
import { normalizeBunMachO } from './normalize-bun-macho.mts';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const platform = process.platform;
const architecture = process.arch;
const executableSuffix = platform === 'win32' ? '.exe' : '';
const outputDirectory = path.join(rootDirectory, 'desktop', 'runtime', `${platform}-${architecture}`);
const codegraphRequire = createRequire(path.join(rootDirectory, 'codegraph', 'package.json'));
const bunBuildArtifactPattern = /^\.[0-9a-f]+-[0-9a-f]+\.bun-build$/;

interface RuntimeEntry {
  entry: string;
  output: string;
  label: string;
}

const runtimeEntries: RuntimeEntry[] = [
  {
    entry: path.join(rootDirectory, 'desktop', 'backend', 'codegraph-host.ts'),
    output: path.join(outputDirectory, `cheshi-codegraph-host${executableSuffix}`),
    label: 'Cheshi CodeGraph runtime',
  },
  {
    entry: path.join(rootDirectory, 'cli', 'cheshi-cli.ts'),
    output: path.join(outputDirectory, `cheshi-cli${executableSuffix}`),
    label: 'Cheshi CLI runtime',
  },
  {
    entry: path.join(rootDirectory, 'codegraph', 'src', 'mcp', 'liveness-watchdog-child.ts'),
    output: path.join(outputDirectory, `codegraph-watchdog${executableSuffix}`),
    label: 'CodeGraph watchdog runtime',
  },
];
const workerEntries: ReadonlyArray<readonly [name: string, entry: string]> = [
  ['parse-worker', path.join(rootDirectory, 'codegraph', 'src', 'extraction', 'parse-worker.ts')],
  ['store-worker', path.join(rootDirectory, 'codegraph', 'src', 'extraction', 'store-worker.ts')],
  ['resolver-worker', path.join(rootDirectory, 'codegraph', 'src', 'resolution', 'resolver-worker.ts')],
  ['query-worker', path.join(rootDirectory, 'codegraph', 'src', 'mcp', 'query-worker.ts')],
  ['shimmer-worker', path.join(rootDirectory, 'codegraph', 'src', 'ui', 'shimmer-worker.ts')],
];

function removeBunBuildArtifacts(): void {
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !bunBuildArtifactPattern.test(entry.name)) continue;
    rmSync(path.join(rootDirectory, entry.name), { force: true });
  }
}

function copyWasmFiles(sourceDirectory: string, targetDirectory: string): void {
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== '.wasm') continue;
    copyFileSync(path.join(sourceDirectory, entry.name), path.join(targetDirectory, entry.name));
  }
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
removeBunBuildArtifacts();

try {
  await buildDesktopPreload();
  await buildAppleCalendar();

  for (const runtime of runtimeEntries) {
    const result = Bun.spawnSync([
      process.execPath,
      'build',
      '--compile',
      runtime.entry,
      '--outfile',
      runtime.output,
    ], {
      cwd: rootDirectory,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) throw new Error(`Failed to build ${runtime.label}.`);
    if (platform !== 'win32') chmodSync(runtime.output, 0o755);
    if (platform === 'darwin' && process.env.CHESHI_SIGN_RELEASE === '1') {
      await normalizeBunMachO(runtime.output);
    }
  }

  const workersDirectory = path.join(outputDirectory, 'workers');
  mkdirSync(workersDirectory, { recursive: true });
  for (const [name, entry] of workerEntries) {
    const output = path.join(workersDirectory, `${name}.js`);
    const result = Bun.spawnSync([
      process.execPath,
      'build',
      entry,
      '--target',
      'bun',
      '--outfile',
      output,
    ], {
      cwd: rootDirectory,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) throw new Error(`Failed to build ${name}.`);
  }

  const webTreeSitterEntry = codegraphRequire.resolve('web-tree-sitter');
  copyFileSync(
    path.join(path.dirname(webTreeSitterEntry), 'tree-sitter.wasm'),
    path.join(outputDirectory, 'tree-sitter.wasm'),
  );
  copyFileSync(
    path.join(rootDirectory, 'codegraph', 'src', 'db', 'schema.sql'),
    path.join(outputDirectory, 'schema.sql'),
  );
  copyFileSync(
    path.join(rootDirectory, '.env.product'),
    path.join(outputDirectory, '.env.product'),
  );

  const grammarsDirectory = path.join(outputDirectory, 'grammars');
  mkdirSync(grammarsDirectory, { recursive: true });
  const packagedGrammar = codegraphRequire.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm');
  copyWasmFiles(path.dirname(packagedGrammar), grammarsDirectory);
  copyWasmFiles(
    path.join(rootDirectory, 'codegraph', 'src', 'extraction', 'wasm'),
    grammarsDirectory,
  );

  const languageServerModulesDirectory = path.join(outputDirectory, 'language-servers', 'node_modules');
  mkdirSync(languageServerModulesDirectory, { recursive: true });
  for (const packageName of BUNDLED_LANGUAGE_SERVER_PACKAGES) {
    cpSync(
      path.join(rootDirectory, 'node_modules', packageName),
      path.join(languageServerModulesDirectory, packageName),
      { recursive: true, dereference: true },
    );
  }
} finally {
  removeBunBuildArtifacts();
}

process.stdout.write(`Cheshi desktop runtimes built in ${outputDirectory}\n`);
