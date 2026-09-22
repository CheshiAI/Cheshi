import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { ResolvedForgeConfig } from '@electron-forge/shared-types';

import { product } from '../../config/product.mts';
import { macOSSigningOptions } from '../../config/macos-signing.mts';
import {
  CODEGRAPH_DATA_ROOT_ENV,
  codeGraphStorageDirectory,
} from '../../config/workspace-storage.mts';
import createForgeConfiguration from '../../forge.config.mts';

const rootDirectory = fileURLToPath(new URL('../..', import.meta.url));
const desktopLibraryNames = [
  'chat-attachment-store',
  'codegraph-service',
  'codex-account-service',
  'codex-app-server-client',
  'codex-chat-service',
  'codex-service-utils',
  'ghostty-surface-host',
  'git-service',
  'json-rpc-client-utils',
  'language-server-client',
  'language-server-manager',
  'language-server-runtime',
  'plugin-logo-service',
  'skill-recording-store',
  'terminal-controller',
  'workspace-file-service',
] as const;
const desktopScriptNames = [
  'build-desktop-preload',
  'build-desktop-runtime',
  'forward-desktop-dev-output',
  'prepare-ghostty',
  'start-desktop-dev',
  'watch-file-contents',
] as const;

function runtimeImportSpecifiers(sourcePath: string): string[] {
  const { outputText } = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    fileName: sourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  });
  return ts.preProcessFile(outputText, true, true).importedFiles
    .map(({ fileName }) => fileName)
    .filter((specifier) => specifier.startsWith('.'));
}

test('uses typed Electron entrypoints and a generated sandboxed preload', async () => {
  const packageSource = readFileSync(path.join(rootDirectory, 'package.json'), 'utf8');
  const configuration = await createForgeConfiguration();
  const shouldIgnore = configuration.packagerConfig?.ignore;
  const extraResources = configuration.packagerConfig?.extraResource;
  if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');
  if (!Array.isArray(extraResources)) throw new Error('Forge extra resources are unavailable.');

  assert.match(packageSource, /"main": "desktop\/bootstrap\.mts"/u);
  assert.equal(existsSync(path.join(rootDirectory, 'desktop', 'bootstrap.mts')), true);
  assert.equal(existsSync(path.join(rootDirectory, 'desktop', 'main.mts')), true);
  assert.equal(existsSync(path.join(rootDirectory, 'desktop', 'preload.cts')), true);
  assert.equal(existsSync(path.join(rootDirectory, 'forge.config.mts')), true);
  assert.equal(existsSync(path.join(rootDirectory, 'desktop', 'main.mjs')), false);
  assert.equal(existsSync(path.join(rootDirectory, 'desktop', 'preload.cjs')), false);
  assert.equal(existsSync(path.join(rootDirectory, 'forge.config.cjs')), false);

  assert.equal(shouldIgnore('/desktop/main.mts'), false);
  assert.equal(shouldIgnore('/desktop/bootstrap.mts'), false);
  assert.equal(shouldIgnore('/resources'), false);
  assert.equal(shouldIgnore('/resources/icons'), false);
  assert.equal(shouldIgnore('/resources/icons/startup-logo.png'), false);
  assert.equal(shouldIgnore('/resources/icons/startup-logo.png.tmp'), true);
  assert.equal(shouldIgnore('/resources/icons/app-icon.png'), false);
  assert.equal(shouldIgnore('/resources/icons/app-icon.png.tmp'), true);
  assert.equal(shouldIgnore('/resources/icons/about-logo.png'), false);
  assert.equal(shouldIgnore('/resources/icons/about-logo.png.tmp'), true);
  assert.equal(existsSync(path.join(rootDirectory, 'resources', 'icons', 'about-logo.png')), true);
  assert.equal(existsSync(path.join(rootDirectory, 'resources', 'icons', 'app-icon.png')), true);
  const appIcon = path.join(rootDirectory, 'resources', 'icons', 'app-icon.icns');
  assert.equal(configuration.packagerConfig?.icon, appIcon);
  assert.equal(readFileSync(appIcon).subarray(0, 4).toString(), 'icns');
  assert.equal(shouldIgnore('/resources/other'), true);
  assert.equal(existsSync(path.join(rootDirectory, 'resources', 'icons', 'startup-logo.png')), true);
  const startupTokensPath = 'desktop/frontend/src/shared/styles/tokens.css';
  const tokenSegments = startupTokensPath.split('/');
  for (let depth = 1; depth <= tokenSegments.length; depth += 1) {
    assert.equal(shouldIgnore(`/${tokenSegments.slice(0, depth).join('/')}`), false);
  }
  assert.equal(existsSync(path.join(rootDirectory, startupTokensPath)), true);
  assert.equal(shouldIgnore(`/${startupTokensPath}.tmp`), true);
  assert.equal(shouldIgnore('/desktop/frontend/src/App.tsx'), true);
  assert.equal(shouldIgnore('/desktop/main.mjs'), true);
  assert.equal(shouldIgnore('/desktop/preload.cts'), true);
  assert.ok(extraResources.includes(path.join(rootDirectory, 'desktop', 'runtime')));

  const generatedPreload = readFileSync(
    path.join(rootDirectory, 'desktop', 'runtime', 'preload.cjs'),
    'utf8',
  );
  assert.match(generatedPreload, /require\(["']electron["']\)/u);
  assert.doesNotMatch(generatedPreload, /^import\s/mu);
});

test('loads the typed configuration modules in the Node runtime', () => {
  assert.ok(product.displayName.length > 0);
  assert.equal(CODEGRAPH_DATA_ROOT_ENV, 'CODEGRAPH_DATA_ROOT');
  assert.equal(
    path.basename(codeGraphStorageDirectory('/tmp/cheshi-data', '/tmp/cheshi-workspace')),
    'codegraph',
  );
});

test('uses product metadata for the distributable version without changing the source manifest', async () => {
  const configuration = await createForgeConfiguration();
  const hook = configuration.hooks?.readPackageJson;
  assert.equal(typeof hook, 'function');
  if (typeof hook !== 'function') throw new Error('Forge package metadata hook is unavailable.');
  const source = { name: 'example-package', version: '0.0.0' };
  const result = await hook(configuration as ResolvedForgeConfig, source);
  assert.deepEqual(result, { ...source, version: product.version });
  assert.equal(source.version, '0.0.0');
});

test('keeps signing and notarization opt in for local builds', () => {
  for (const setting of [undefined, '', '0', 'false', 'true']) {
    assert.deepEqual(macOSSigningOptions({ CHESHI_SIGN_RELEASE: setting }, 'darwin'), {});
  }
});

test('reads signing identity and notarization profile from the build environment', () => {
  const environment = {
    CHESHI_SIGN_RELEASE: '1',
    MACOS_SIGNING_IDENTITY: ' Developer ID Application: Example Company (EXAMPLE123) ',
    MACOS_NOTARY_PROFILE: ' ExampleNotary ',
  };
  const configuration = macOSSigningOptions(environment, 'darwin');
  const { optionsForFile, ...signing } = configuration.osxSign!;
  assert.deepEqual({ ...configuration, osxSign: signing }, {
    osxSign: {
      identity: 'Developer ID Application: Example Company (EXAMPLE123)',
      type: 'distribution',
      continueOnError: false,
    },
    osxNotarize: { keychainProfile: 'ExampleNotary' },
  });
  assert.equal(typeof optionsForFile, 'function');
  const appEntitlements = optionsForFile?.('/output/Cheshi.app').entitlements;
  assert.equal(appEntitlements, path.join(rootDirectory, 'config', 'macos-entitlements.plist'));
  assert.deepEqual(optionsForFile?.('/output/Cheshi.app/Contents/Frameworks/Cheshi Helper (Renderer).app'), {});
  assert.deepEqual(optionsForFile?.('/output/Cheshi.app/Contents/MacOS/Cheshi'), {});
  assert.match(readFileSync(String(appEntitlements), 'utf8'), /<key>com.apple.security.automation.apple-events<\/key>\s*<true\/>/);
  assert.throws(() => macOSSigningOptions(environment, 'linux'), /require macOS/);
  assert.throws(() => macOSSigningOptions(environment, 'win32'), /require macOS/);
});

test('fails signed builds when a required signing environment value is missing', () => {
  assert.throws(() => macOSSigningOptions({ CHESHI_SIGN_RELEASE: '1' }, 'darwin'), /MACOS_SIGNING_IDENTITY/);
  assert.throws(() => macOSSigningOptions({
    CHESHI_SIGN_RELEASE: '1', MACOS_SIGNING_IDENTITY: 'Example identity', MACOS_NOTARY_PROFILE: ' ',
  }, 'darwin'), /MACOS_NOTARY_PROFILE/);
});

test('packages only the TypeScript configuration sources', async () => {
  const configuration = await createForgeConfiguration();
  const shouldIgnore = configuration.packagerConfig?.ignore;
  if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');

  assert.equal(shouldIgnore('/config/product.mts'), false);
  assert.equal(shouldIgnore('/config/workspace-storage.mts'), false);
  assert.equal(shouldIgnore('/.env.product'), false);
  assert.equal(shouldIgnore('/.env.local'), true);
  assert.equal(shouldIgnore('/.env.signing'), true);
  assert.equal(shouldIgnore('/config/product.mjs'), true);
  assert.equal(shouldIgnore('/config/product.d.mts'), true);
  assert.equal(shouldIgnore('/config/workspace-storage.mjs'), true);
  assert.equal(shouldIgnore('/config/workspace-storage.d.mts'), true);

  for (const obsoletePath of [
    'config/product.mjs',
    'config/product.d.mts',
    'config/workspace-storage.mjs',
    'config/workspace-storage.d.mts',
  ]) {
    assert.equal(existsSync(path.join(rootDirectory, obsoletePath)), false);
  }
});

test('packages only the TypeScript desktop library sources', async () => {
  const configuration = await createForgeConfiguration();
  const shouldIgnore = configuration.packagerConfig?.ignore;
  if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');

  for (const libraryName of desktopLibraryNames) {
    const typedPath = `desktop/lib/${libraryName}.mts`;
    const legacyPath = `desktop/lib/${libraryName}.mjs`;
    assert.equal(shouldIgnore(`/${typedPath}`), false);
    assert.equal(shouldIgnore(`/${legacyPath}`), true);
    assert.equal(existsSync(path.join(rootDirectory, typedPath)), true);
    assert.equal(existsSync(path.join(rootDirectory, legacyPath)), false);
  }

  assert.equal(existsSync(path.join(rootDirectory, 'desktop/lib/workspace-file-service.d.mts')), false);
});

test('includes every extracted desktop service and IPC module in the packaged app', async () => {
  const configuration = await createForgeConfiguration();
  const shouldIgnore = configuration.packagerConfig?.ignore;
  if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');

  const modules = readdirSync(path.join(rootDirectory, 'desktop', 'lib'))
    .filter((name) => /^(?:codex-chat|git|github-pull-request|language-server|workspace-file)-.*\.mts$/u.test(name));
  assert.ok(modules.includes('codex-chat-service.mts'));
  for (const name of modules) {
    assert.equal(shouldIgnore(`/desktop/lib/${name}`), false, `${name} must be packaged`);
    assert.equal(shouldIgnore(`/desktop/lib/${name}.tmp`), true);
  }
});

test('packages every relative runtime import reachable from the Electron entrypoint', async () => {
  const configuration = await createForgeConfiguration();
  const shouldIgnore = configuration.packagerConfig?.ignore;
  if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');

  const { main } = JSON.parse(readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'));
  const pending = [path.join(rootDirectory, main)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    assert.ok(sourcePath);
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);

    const relativePath = path.relative(rootDirectory, sourcePath).replaceAll('\\', '/');
    assert.ok(existsSync(sourcePath), `${relativePath} must exist`);
    for (let entry = relativePath; entry !== '.'; entry = path.posix.dirname(entry)) {
      assert.equal(shouldIgnore(`/${entry}`), false, `${entry} must be packaged for ${relativePath}`);
    }
    for (const specifier of runtimeImportSpecifiers(sourcePath)) {
      pending.push(path.resolve(path.dirname(sourcePath), specifier));
    }
  }
  assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'shared', 'plugin-actions.ts')));
  assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'lib', 'skill-recording-store.mts')));
  for (const name of ['service', 'script', 'process', 'ipc']) {
    assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'lib', `apple-notes-${name}.mts`)));
  }
  assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'shared', 'apple-notes.ts')));
  for (const name of ['service', 'process', 'ipc']) {
    assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'lib', `apple-calendar-${name}.mts`)));
  }
  assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'shared', 'apple-calendar.ts')));
  assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'main.mts')));
  assert.ok(visited.has(path.join(rootDirectory, 'desktop', 'lib', 'startup-page.mts')));
  assert.equal(shouldIgnore('/desktop/shared/plugin-actions.ts.tmp'), true);
  assert.equal(shouldIgnore('/desktop/shared/plugin-actions.d.ts'), true);
  assert.equal(shouldIgnore('/desktop/shared/plugin-actions.ts/nested'), true);
});

test('uses only TypeScript desktop scripts', () => {
  const packageSource = readFileSync(path.join(rootDirectory, 'package.json'), 'utf8');

  for (const scriptName of desktopScriptNames) {
    assert.equal(existsSync(path.join(rootDirectory, 'scripts', `${scriptName}.mts`)), true);
    assert.equal(existsSync(path.join(rootDirectory, 'scripts', `${scriptName}.mjs`)), false);
  }

  assert.doesNotMatch(packageSource, /scripts\/[^"\s]+\.mjs/);
  for (const entrypoint of ['build-desktop-runtime', 'prepare-ghostty', 'start-desktop-dev']) {
    assert.match(packageSource, new RegExp(`scripts/${entrypoint}\\.mts`));
  }
});

test('uses TypeScript desktop tests while keeping only the child-process fixture as ESM JavaScript', () => {
  const packageSource = readFileSync(path.join(rootDirectory, 'package.json'), 'utf8');
  const testDirectory = path.join(rootDirectory, 'desktop', 'test');
  const rootJavaScriptTests = readdirSync(testDirectory)
    .filter((name) => name.endsWith('.mjs'));

  assert.deepEqual(rootJavaScriptTests, ['fake-language-server.mjs']);
  assert.doesNotMatch(packageSource, /desktop\/test\/[^"\s]+\.mjs/u);
  assert.equal(
    existsSync(path.join(testDirectory, 'fake-language-server.mjs')),
    true,
  );
});
