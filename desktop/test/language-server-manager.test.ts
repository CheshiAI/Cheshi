import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LanguageServerManager,
  typescriptLanguageIdForPath,
} from '../lib/language-server-manager.mts';

const fixturePath = fileURLToPath(new URL('./fake-language-server.mjs', import.meta.url));
type ManagerOptions = ConstructorParameters<typeof LanguageServerManager>[0];
type LanguageServerDefinitions = NonNullable<ManagerOptions['definitions']>;
type BundledCommands = NonNullable<ManagerOptions['bundledCommands']>;
type DiagnosticsListener = Parameters<LanguageServerManager['onDiagnostics']>[0];
type DiagnosticsEvent = Parameters<DiagnosticsListener>[0];
type CreateManagerOptions = {
  definitions?: LanguageServerDefinitions;
  bundledCommands?: BundledCommands;
};

function definitions(): LanguageServerDefinitions {
  return {
    rust: {
      displayName: 'Rust',
      serverName: 'fake-language-server',
      command: process.execPath,
      args: [fixturePath],
      rootMarkers: ['Cargo.toml'],
      languageId: () => 'rust',
    },
    typescript: {
      displayName: 'TypeScript',
      serverName: 'fake-typescript-server',
      command: process.execPath,
      args: [fixturePath],
      rootMarkers: ['tsconfig.json'],
      languageId: () => 'typescript',
    },
    python: {
      displayName: 'Python',
      serverName: 'fake-python-server',
      command: process.execPath,
      args: [fixturePath],
      rootMarkers: ['pyproject.toml'],
      languageId: () => 'python',
    },
  };
}

function createManager(
  root: string,
  settingsPath: string,
  options: CreateManagerOptions = {},
): LanguageServerManager {
  return new LanguageServerManager({
    workspaceRoot: root,
    settingsPath,
    definitions: options.definitions ?? definitions(),
    clientInfo: { name: 'cheshi-test', version: '0.0.0' },
    homeDirectory: root,
    environment: { PATH: '' },
    bundledCommands: options.bundledCommands,
    requestTimeoutMs: 5_000,
  });
}

function waitForDiagnostics(manager: LanguageServerManager): Promise<DiagnosticsEvent> {
  return new Promise<DiagnosticsEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      removeListener();
      reject(new Error('Timed out waiting for fake language server diagnostics.'));
    }, 5_000);
    const removeListener = manager.onDiagnostics((value) => {
      clearTimeout(timeout);
      removeListener();
      resolve(value);
    });
  });
}

test('maps JavaScript and TypeScript file variants to LSP language identifiers', () => {
  assert.equal(typescriptLanguageIdForPath('src/app.js'), 'javascript');
  assert.equal(typescriptLanguageIdForPath('src/app.mjs'), 'javascript');
  assert.equal(typescriptLanguageIdForPath('src/app.cjs'), 'javascript');
  assert.equal(typescriptLanguageIdForPath('src/app.jsx'), 'javascriptreact');
  assert.equal(typescriptLanguageIdForPath('src/app.ts'), 'typescript');
  assert.equal(typescriptLanguageIdForPath('src/app.mts'), 'typescript');
  assert.equal(typescriptLanguageIdForPath('src/app.cts'), 'typescript');
  assert.equal(typescriptLanguageIdForPath('src/app.tsx'), 'typescriptreact');
});

test('enables available language servers automatically by default', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-auto-'));
  try {
    const manager = createManager(root, path.join(root, 'language-servers.json'));
    assert.deepEqual(
      manager.getStatuses().map(({ language, mode, state }) => ({ language, mode, state })),
      [
        { language: 'rust', mode: 'auto', state: 'available' },
        { language: 'typescript', mode: 'auto', state: 'available' },
        { language: 'python', mode: 'auto', state: 'available' },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrates legacy disabled defaults to automatic mode', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-migration-'));
  const settingsPath = path.join(root, 'language-servers.json');
  try {
    writeFileSync(settingsPath, `${JSON.stringify({
      version: 1,
      languages: Object.fromEntries(
        Object.keys(definitions()).map((language) => [language, { mode: 'disabled', executable: null }]),
      ),
    })}\n`);
    const manager = createManager(root, settingsPath);
    assert.ok(manager.getStatuses().every(({ mode }) => mode === 'auto'));
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      version: number;
      languages: Record<string, { mode: string }>;
    };
    assert.equal(persisted.version, 2);
    assert.ok(Object.values(persisted.languages).every((setting) => setting.mode === 'auto'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves an explicit disabled choice in current settings', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-disabled-'));
  const settingsPath = path.join(root, 'language-servers.json');
  try {
    const manager = createManager(root, settingsPath);
    await manager.configure({ language: 'rust', mode: 'disabled' });
    const restored = createManager(root, settingsPath);
    const rust = restored.getStatuses().find(({ language }) => language === 'rust');
    assert.equal(rust?.mode, 'disabled');
    assert.equal(rust?.state, 'disabled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses a bundled command when an external Workspace has no server executable', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-bundled-'));
  const settingsPath = path.join(root, 'language-servers.json');
  const bundledDefinitions = definitions();
  const typescriptDefinition = bundledDefinitions.typescript;
  if (!typescriptDefinition) throw new Error('Expected the TypeScript language-server definition.');
  typescriptDefinition.command = 'missing-typescript-language-server';
  const manager = createManager(root, settingsPath, {
    definitions: bundledDefinitions,
    bundledCommands: {
      typescript: {
        executable: process.execPath,
        args: [fixturePath],
        environment: { CHESHI_FAKE_LANGUAGE_SERVER: '1' },
        availabilityPath: fixturePath,
      },
    },
  });
  try {
    const status = manager.getStatuses().find(({ language }) => language === 'typescript');
    assert.equal(status?.mode, 'auto');
    assert.equal(status?.state, 'available');
    assert.equal(status?.executable, fixturePath);

    const result = await manager.getCompletions({
      language: 'typescript',
      path: 'app.ts',
      content: 'fa\n',
      version: 1,
      position: { line: 0, character: 2 },
    });
    assert.equal(result.items[0]?.label, 'fakeCompletion');
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs the detected workspace Node server with the bundled runtime and no Node on PATH', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-local-node-'));
  const server = path.join(root, 'project-server.mjs');
  const executable = path.join(root, 'node_modules', '.bin', 'project-language-server');
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(server, '#!/usr/bin/env node\n' + readFileSync(fixturePath, 'utf8')
    .replace('fakeCompletion', 'projectCompletion'), { mode: 0o755 });
  createSymbolicLink(server, executable);
  const manager = createManager(root, path.join(root, 'language-servers.json'), {
    definitions: { typescript: {
      ...definitions().typescript!, command: 'project-language-server', args: [],
    } },
    bundledCommands: { typescript: {
      executable: process.execPath, args: [fixturePath], availabilityPath: fixturePath,
      environment: { PATH: '', ELECTRON_RUN_AS_NODE: '1' },
    } },
  });
  try {
    const command = manager.resolveCommand('typescript', root);
    assert.equal(command?.executable, process.execPath);
    assert.equal(command?.displayPath, executable);
    assert.equal(command?.environment?.PATH, '');
    const result = await manager.getCompletions({
      language: 'typescript', path: 'app.ts', content: 'fa\n', version: 1,
      position: { line: 0, character: 2 },
    });
    assert.equal(result.items[0]?.label, 'projectCompletion');
    assert.equal(manager.getStatuses()[0]?.state, 'running');

    // An explicit Custom choice retains its executable and launch semantics.
    await manager.configure({ language: 'typescript', mode: 'custom', executable });
    assert.equal(manager.resolveCommand('typescript', root)?.executable, executable);
    assert.deepEqual(manager.resolveCommand('typescript', root)?.args, []);
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists a custom executable selection', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-settings-'));
  const settingsPath = path.join(root, 'language-servers.json');
  try {
    const manager = createManager(root, settingsPath);
    await manager.configure({ language: 'python', mode: 'custom', executable: process.execPath });
    const restored = createManager(root, settingsPath);
    const python = restored.getStatuses().find(({ language }) => language === 'python');
    assert.equal(python?.mode, 'custom');
    assert.equal(python?.state, 'available');
    assert.equal(python?.executable, process.execPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('starts a project-rooted server and exposes diagnostics and editor language features', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-diagnostics-'));
  const projectRoot = path.join(root, 'crate');
  const settingsPath = path.join(root, 'language-servers.json');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.0.0"\n');
  writeFileSync(path.join(projectRoot, 'src', 'main.rs'), 'fn main() {}\n');
  const manager = createManager(root, settingsPath);
  try {
    await manager.configure({ language: 'rust', mode: 'auto' });
    const diagnosticsPromise = waitForDiagnostics(manager);
    const result = await manager.updateDocument({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'broken source\n',
      version: 1,
    });
    assert.equal(result.active, true);
    assert.equal(result.status.state, 'running');

    const event = await diagnosticsPromise;
    assert.equal(event.language, 'rust');
    assert.equal(event.path, 'crate/src/main.rs');
    assert.equal(event.version, 1);
    const diagnostic = event.diagnostics[0];
    if (diagnostic === null || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
      throw new Error('Expected the fake language server diagnostic.');
    }
    const diagnosticRecord = diagnostic as Record<string, unknown>;
    assert.equal(diagnosticRecord.code, 'fake-error');
    const diagnosticMessage = diagnosticRecord.message;
    if (typeof diagnosticMessage !== 'string') throw new Error('Expected a diagnostic message.');
    assert.ok(diagnosticMessage.endsWith(projectRoot));

    const completions = await manager.getCompletions({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fa }\n',
      version: 2,
      position: { line: 0, character: 14 },
    });
    assert.deepEqual(completions, {
      isIncomplete: false,
      items: [{
        label: 'fakeCompletion',
        detail: 'Fake completion detail',
        documentation: 'Fake completion documentation.',
        kind: 3,
        sortText: null,
        filterText: null,
        insertText: 'completedValue',
        textEdit: {
          range: { start: { line: 0, character: 12 }, end: { line: 0, character: 14 } },
          newText: 'completedValue',
        },
        deprecated: true,
        commitCharacters: ['.'],
      }],
    });

    const hover = await manager.getHover({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 3,
      position: { line: 0, character: 15 },
    });
    assert.deepEqual(hover, {
      contents: ['fn fake_completion() -> i32', 'Fake hover documentation.'],
      range: { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } },
    });

    const definitions = await manager.getDefinitions({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 4,
      position: { line: 0, character: 15 },
    });
    assert.deepEqual(definitions, {
      locations: [{
        path: 'crate/src/main.rs',
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
      }],
    });

    const references = await manager.getReferences({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 5,
      position: { line: 0, character: 15 },
    });
    assert.deepEqual(references, {
      locations: [
        {
          path: 'crate/src/main.rs',
          range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
        },
        {
          path: 'crate/src/main.rs',
          range: { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } },
        },
      ],
    });

    const signatureHelp = await manager.getSignatureHelp({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(value, 2); }\n',
      version: 6,
      position: { line: 0, character: 35 },
    });
    assert.deepEqual(signatureHelp, {
      signatures: [{
        label: 'fakeCompletion(value: string, count: number): number',
        documentation: 'Fake signature documentation.',
        parameters: [
          { label: 'value: string', documentation: 'The value.' },
          { label: 'count: number', documentation: 'The count.' },
        ],
        activeParameter: null,
      }],
      activeSignature: 0,
      activeParameter: 1,
    });

    const prepareRename = await manager.prepareRename({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 7,
      position: { line: 0, character: 15 },
    });
    assert.deepEqual(prepareRename, {
      available: true,
      range: { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } },
      placeholder: 'fakeCompletion',
    });

    const unavailableRename = await manager.prepareRename({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 8,
      position: { line: 0, character: 0 },
    });
    assert.deepEqual(unavailableRename, {
      available: false,
      range: null,
      placeholder: null,
    });

    const defaultRename = await manager.prepareRename({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 9,
      position: { line: 0, character: 1 },
    });
    assert.deepEqual(defaultRename, {
      available: true,
      range: null,
      placeholder: null,
    });

    const rename = await manager.renameSymbol({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 10,
      position: { line: 0, character: 15 },
      newName: 'renamedCompletion',
    });
    assert.deepEqual(rename, {
      edit: {
        files: [{
          path: 'crate/src/main.rs',
          edits: [{
            range: { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } },
            newText: 'renamedCompletion',
          }],
        }],
      },
      failureReason: null,
    });

    const rejectedRename = await manager.renameSymbol({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'fn main() { fakeCompletion(); }\n',
      version: 11,
      position: { line: 0, character: 15 },
      newName: 'outsideWorkspace',
    });
    assert.equal(rejectedRename.edit, null);
    assert.match(rejectedRename.failureReason ?? '', /outside the Workspace/u);

    const codeActions = await manager.getCodeActions({
      language: 'rust',
      path: 'crate/src/main.rs',
      content: 'broken source\n',
      version: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        code: 'fake-error',
        source: 'fake-lsp',
        message: 'fake diagnostic',
      }],
    });
    assert.deepEqual(codeActions, {
      actions: [{
        title: 'Apply fake quick fix',
        kind: 'quickfix',
        preferred: true,
        disabledReason: null,
        edit: {
          files: [{
            path: 'crate/src/main.rs',
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: 'fixed',
            }],
          }],
        },
      }, {
        title: 'Apply incomplete fake refactor',
        kind: 'refactor',
        preferred: false,
        disabledReason: 'This action requires an unsupported language-server command.',
        edit: {
          files: [{
            path: 'crate/src/main.rs',
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: 'partial',
            }],
          }],
        },
      }],
    });

    await manager.closeDocument({ language: 'rust', path: 'crate/src/main.rs' });
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses default rename behavior when prepare rename is not advertised', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-lsp-rename-default-'));
  const settingsPath = path.join(root, 'language-servers.json');
  const renameDefinitions = definitions();
  const rustDefinition = renameDefinitions.rust;
  if (!rustDefinition) throw new Error('Expected the Rust language-server definition.');
  rustDefinition.args = [fixturePath, '--rename-without-prepare'];
  const manager = createManager(root, settingsPath, { definitions: renameDefinitions });
  try {
    const result = await manager.prepareRename({
      language: 'rust',
      path: 'src/main.rs',
      content: 'fn main() {}\n',
      version: 1,
      position: { line: 0, character: 3 },
    });
    assert.deepEqual(result, { available: true, range: null, placeholder: null });
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
