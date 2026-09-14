import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { resolveNodeScriptCommand } from '../lib/language-server-command.mts';
import { LanguageServerManager } from '../lib/language-server-manager.mts';

function createWorkspace(context: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-node-runtime-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeExecutable(root: string, name: string, content: string) {
  const executable = path.join(root, name);
  writeFileSync(executable, content, { mode: 0o755 });
  return executable;
}

function createManager(root: string, command: string) {
  return new LanguageServerManager({
    workspaceRoot: root,
    settingsPath: path.join(root, 'language-servers.json'),
    homeDirectory: root,
    environment: { PATH: '' },
    clientInfo: { name: 'cheshi-test', version: '0.0.0' },
    definitions: {
      typescript: {
        displayName: 'TypeScript', serverName: 'fixture', command,
        args: ['--stdio'], rootMarkers: ['tsconfig.json'], languageId: () => 'typescript',
      },
    },
  });
}

test('uses the application runtime for supported Node shebangs and preserves argument boundaries', (context) => {
  const root = createWorkspace(context);
  for (const [index, shebang] of ['#!/usr/bin/env node\n', '#!/opt/nvm/bin/node\r\n'].entries()) {
    const executable = writeExecutable(root, `server ${index}.mjs`, `${shebang}process.exit(0);\n`);
    const args = ['--stdio', 'argument with spaces'];
    const command = resolveNodeScriptCommand(executable, args);
    assert.deepEqual(command, {
      executable: process.execPath,
      args: [executable, ...args],
      environment: { ELECTRON_RUN_AS_NODE: '1' },
      displayPath: executable,
    });
    assert.deepEqual(args, ['--stdio', 'argument with spaces']);
  }
});

test('leaves native executables, shell scripts, other interpreters and unsupported shebang flags untouched', (context) => {
  const root = createWorkspace(context);
  assert.equal(resolveNodeScriptCommand(process.execPath, []), null);
  const scripts = [
    '#!/bin/sh\nexit 0\n',
    '#!/usr/bin/env python3\n',
    '#!/usr/bin/env node --inspect\n',
    '#!/usr/bin/env -S node --loader custom\n',
    '#!/usr/bin/node --experimental-transform-types\n',
    'process.exit(0);\n',
  ];
  for (const [index, content] of scripts.entries()) {
    const executable = writeExecutable(root, `script-${index}`, content);
    assert.equal(resolveNodeScriptCommand(executable, ['--stdio']), null);
  }
  assert.equal(resolveNodeScriptCommand(path.join(root, 'missing'), []), null);
  assert.equal(resolveNodeScriptCommand(root, []), null);
});

test('automatic native and shell commands remain direct and custom Node commands remain explicitly configured', async (context) => {
  const root = createWorkspace(context);
  const shell = writeExecutable(root, 'shell-server', '#!/bin/sh\nexit 0\n');
  const nodeScript = writeExecutable(root, 'node-server', '#!/usr/bin/env node\nprocess.exit(0);\n');
  for (const executable of [process.execPath, shell]) {
    const manager = createManager(root, executable);
    try {
      assert.deepEqual(manager.resolveCommand('typescript', root), {
        executable, args: ['--stdio'], environment: {}, displayPath: executable,
      });
    } finally {
      await manager.stop();
    }
  }
  const manager = createManager(root, nodeScript);
  try {
    await manager.configure({ language: 'typescript', mode: 'custom', executable: nodeScript });
    assert.deepEqual(manager.resolveCommand('typescript', root), {
      executable: nodeScript, args: ['--stdio'], environment: {}, displayPath: nodeScript,
    });
  } finally {
    await manager.stop();
  }
});

test('a project-local Node server initializes and serves diagnostics and completions with no node on PATH', (context) => {
  const root = createWorkspace(context);
  const serverDirectory = path.join(root, 'node_modules', 'local-server');
  const binDirectory = path.join(root, 'node_modules', '.bin');
  mkdirSync(serverDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  const entrypoint = writeExecutable(serverDirectory, 'entrypoint.mjs', `#!/usr/bin/env node
import assert from 'node:assert/strict';
assert.equal(process.env.PATH, '');
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
assert.deepEqual(process.argv.slice(2), ['--stdio', 'local version']);
await import('./implementation.mjs');
`);
  writeFileSync(path.join(serverDirectory, 'implementation.mjs'), readFileSync(new URL('./fake-language-server.mjs', import.meta.url)));
  const executable = path.join(binDirectory, 'cheshi-fixture-language-server');
  createSymbolicLink('../local-server/entrypoint.mjs', executable);
  writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
  writeFileSync(path.join(root, 'main.ts'), 'broken source\n');

  const direct = spawnSync(executable, ['--stdio'], { env: { ...process.env, PATH: '' }, encoding: 'utf8' });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /node/);

  const managerModule = new URL('../lib/language-server-manager.mts', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { LanguageServerManager } from ${JSON.stringify(managerModule)};
const root = ${JSON.stringify(root)};
const manager = new LanguageServerManager({
  workspaceRoot: root, settingsPath: root + '/language-servers.json', homeDirectory: root,
  environment: process.env, clientInfo: { name: 'cheshi-test', version: '0.0.0' }, requestTimeoutMs: 2000,
  definitions: { typescript: {
    displayName: 'TypeScript', serverName: 'local fixture', command: 'cheshi-fixture-language-server',
    args: ['--stdio', 'local version'], rootMarkers: ['tsconfig.json'], languageId: () => 'typescript',
  } },
});
let timer;
let removeListener;
try {
  const command = manager.resolveCommand('typescript', root);
  assert.equal(command.executable, process.execPath);
  assert.equal(command.args[0], ${JSON.stringify(entrypoint)});
  assert.equal(command.displayPath, ${JSON.stringify(executable)});
  const diagnostics = new Promise((resolve) => {
    removeListener = manager.onDiagnostics(resolve);
    timer = setTimeout(() => resolve(null), 3000);
  });
  const update = await manager.updateDocument({ language: 'typescript', path: 'main.ts', content: 'broken source', version: 1 });
  assert.equal(update.active, true);
  assert.equal(update.status.state, 'running');
  const event = await diagnostics;
  assert.equal(event.path, 'main.ts');
  assert.equal(event.diagnostics[0].code, 'fake-error');
  const completions = await manager.getCompletions({
    language: 'typescript', path: 'main.ts', content: 'fa', version: 2, position: { line: 0, character: 2 },
  });
  assert.equal(completions.items[0].label, 'fakeCompletion');
  process.stdout.write('local server running without external node');
} finally {
  clearTimeout(timer);
  removeListener?.();
  await manager.stop();
}
`], { env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(output, 'local server running without external node');
});
