import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LanguageServerManager } from '../lib/language-server-manager.mts';
import { createBundledLanguageServerCommands } from '../lib/language-server-runtime.mts';

type DiagnosticsListener = Parameters<LanguageServerManager['onDiagnostics']>[0];
type DiagnosticsEvent = Parameters<DiagnosticsListener>[0];

const rootDirectory = path.resolve(import.meta.dirname, '..', '..');
const modulesDirectory = path.resolve(
  process.env.CHESHI_LANGUAGE_SERVER_MODULES_DIR?.trim() || path.join(rootDirectory, 'node_modules'),
);
const runtimeExecutable = path.resolve(
  process.env.CHESHI_LANGUAGE_SERVER_RUNTIME_EXECUTABLE?.trim() || process.execPath,
);
const rustAnalyzerAvailable = spawnSync('rust-analyzer', ['--version'], { stdio: 'ignore' }).status === 0;

function removeTemporaryWorkspace(workspaceRoot: string): void {
  rmSync(workspaceRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

function positionAt(content: string, offset: number) {
  const prefix = content.slice(0, offset);
  const lines = prefix.split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function positionAfterLast(content: string, text: string) {
  const offset = content.lastIndexOf(text);
  assert.notEqual(offset, -1, `Expected fixture content to include ${text}.`);
  return positionAt(content, offset + text.length);
}

function positionInsideFirst(content: string, text: string) {
  const offset = content.indexOf(text);
  assert.notEqual(offset, -1, `Expected fixture content to include ${text}.`);
  return positionAt(content, offset + 1);
}

function positionInsideLast(content: string, text: string) {
  const offset = content.lastIndexOf(text);
  assert.notEqual(offset, -1, `Expected fixture content to include ${text}.`);
  return positionAt(content, offset + 1);
}

function createManager(workspaceRoot: string): LanguageServerManager {
  return new LanguageServerManager({
    workspaceRoot,
    settingsPath: path.join(workspaceRoot, '.cheshi-language-servers.json'),
    clientInfo: { name: 'cheshi-real-server-test', version: '0.0.0' },
    homeDirectory: workspaceRoot,
    environment: { PATH: '' },
    bundledCommands: createBundledLanguageServerCommands({
      runtimeExecutable,
      modulesDirectory,
    }),
    requestTimeoutMs: 20_000,
  });
}

function waitForDiagnostics(
  manager: LanguageServerManager,
  language: string,
  documentPath: string,
): Promise<DiagnosticsEvent> {
  return new Promise<DiagnosticsEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      removeListener();
      reject(new Error(`Timed out waiting for ${language} diagnostics for ${documentPath}.`));
    }, 10_000);
    const removeListener = manager.onDiagnostics((event) => {
      if (event.language !== language || event.path !== documentPath) return;
      clearTimeout(timeout);
      removeListener();
      resolve(event);
    });
  });
}

async function waitForServerResult<Result>(
  request: () => Promise<Result>,
  isReady: (result: Result) => boolean,
  description: string,
): Promise<Result> {
  const deadline = Date.now() + 20_000;
  let latest: Result | undefined;
  while (Date.now() < deadline) {
    latest = await request();
    if (isReady(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`Timed out waiting for ${description}. Last result: ${JSON.stringify(latest)}`);
}

test('uses the bundled TypeScript server for completions and Workspace-only definitions', { timeout: 30_000 }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'cheshi-real-typescript-lsp-'));
  const sourceDirectory = path.join(workspaceRoot, 'src');
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'ESNext', strict: true, target: 'ES2022' },
    include: ['src'],
  }));
  writeFileSync(path.join(sourceDirectory, 'definition.ts'), 'export function answer(): number { return 42; }\n');
  writeFileSync(path.join(sourceDirectory, 'quick-fix.ts'), 'export const missingValue = 7;\n');
  const content = [
    "import * as definition from './definition';",
    'const completionTarget = definition.answer();',
    'completionTar',
    'function greet(name: string, count: number): string { return name.repeat(count); }',
    "const greeting = greet('Cheshi', 2);",
    'const renameTarget = greeting.length;',
    'console.log(renameTarget);',
    'const fixedValue = missingValue;',
    'const values: Array<string> = [];',
    '',
  ].join('\n');
  writeFileSync(path.join(sourceDirectory, 'main.ts'), content);

  const manager = createManager(workspaceRoot);
  try {
    const initialStatus = manager.getStatuses().find(({ language }) => language === 'typescript');
    assert.equal(initialStatus?.mode, 'auto');
    assert.equal(initialStatus?.state, 'available');
    assert.equal(
      initialStatus?.executable,
      path.join(modulesDirectory, 'typescript-language-server', 'lib', 'cli.mjs'),
    );

    const diagnosticsPromise = waitForDiagnostics(manager, 'typescript', 'src/main.ts');
    const completions = await manager.getCompletions({
      language: 'typescript',
      path: 'src/main.ts',
      content,
      version: 1,
      position: positionAfterLast(content, 'completionTar'),
    });
    assert.ok(completions.items.some(({ label }) => label === 'completionTarget'));
    const diagnosticsEvent = await diagnosticsPromise;

    const definitions = await manager.getDefinitions({
      language: 'typescript',
      path: 'src/main.ts',
      content,
      version: 2,
      position: positionInsideFirst(content, 'answer'),
    });
    assert.equal(definitions.locations[0]?.path, 'src/definition.ts');
    assert.equal(definitions.locations[0]?.range.start.line, 0);

    const references = await manager.getReferences({
      language: 'typescript',
      path: 'src/main.ts',
      content,
      version: 3,
      position: positionInsideFirst(content, 'answer'),
    });
    assert.ok(references.locations.some(({ path: locationPath }) => locationPath === 'src/definition.ts'));
    assert.ok(references.locations.some(({ path: locationPath }) => locationPath === 'src/main.ts'));

    const signatureHelp = await manager.getSignatureHelp({
      language: 'typescript',
      path: 'src/main.ts',
      content,
      version: 4,
      position: positionAfterLast(content, "greet('Cheshi', "),
    });
    assert.match(signatureHelp.signatures[0]?.label ?? '', /greet/u);
    assert.equal(signatureHelp.activeParameter, 1);

    const rename = await manager.renameSymbol({
      language: 'typescript',
      path: 'src/main.ts',
      content,
      version: 5,
      position: positionInsideFirst(content, 'renameTarget'),
      newName: 'renamedTarget',
    });
    assert.equal(rename.failureReason, null);
    assert.equal(rename.edit?.files[0]?.path, 'src/main.ts');
    assert.equal(rename.edit?.files[0]?.edits.length, 2);

    const missingDiagnosticValue = diagnosticsEvent.diagnostics.find((diagnostic) => (
      diagnostic !== null
      && typeof diagnostic === 'object'
      && !Array.isArray(diagnostic)
      && (diagnostic as Record<string, unknown>).code === 2304
    ));
    if (missingDiagnosticValue === null || typeof missingDiagnosticValue !== 'object' || Array.isArray(missingDiagnosticValue)) {
      throw new Error(`Expected a missing-name diagnostic: ${JSON.stringify(diagnosticsEvent.diagnostics)}`);
    }
    const missingDiagnostic = missingDiagnosticValue as {
      code: number;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      severity?: number | null;
      source?: string | null;
      message: string;
    };
    const codeActions = await manager.getCodeActions({
      language: 'typescript',
      path: 'src/main.ts',
      content,
      version: 6,
      range: missingDiagnostic.range,
      diagnostics: [missingDiagnostic],
    });
    assert.ok(
      codeActions.actions.some((action) => (
        typeof action.title === 'string'
        && /import/iu.test(action.title)
        && action.disabledReason === null
        && action.edit?.files.some(({ path: editPath }) => editPath === 'src/main.ts')
      )),
      `Expected an editable TypeScript quick fix: ${JSON.stringify(codeActions)}`,
    );

    const externalDefinitions = await manager.getDefinitions({
      language: 'typescript',
      path: 'src/main.ts',
      content,
      version: 7,
      position: positionInsideLast(content, 'Array'),
    });
    assert.deepEqual(externalDefinitions, { locations: [] });
  } finally {
    await manager.stop();
    removeTemporaryWorkspace(workspaceRoot);
  }
});

test('uses the bundled Python server for completions and Workspace-only definitions', { timeout: 30_000 }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'cheshi-real-python-lsp-'));
  writeFileSync(path.join(workspaceRoot, 'pyproject.toml'), '[project]\nname = "cheshi-lsp-fixture"\nversion = "0.0.0"\n');
  writeFileSync(path.join(workspaceRoot, 'definition.py'), 'def answer() -> int:\n    return 42\n');
  const content = [
    'from definition import answer',
    'completion_target = answer()',
    'completion_tar',
    'external_value: str = "value"',
    '',
  ].join('\n');
  writeFileSync(path.join(workspaceRoot, 'main.py'), content);

  const manager = createManager(workspaceRoot);
  try {
    const initialStatus = manager.getStatuses().find(({ language }) => language === 'python');
    assert.equal(initialStatus?.mode, 'auto');
    assert.equal(initialStatus?.state, 'available');
    assert.equal(initialStatus?.executable, path.join(modulesDirectory, 'pyright', 'langserver.index.js'));

    const diagnosticsPromise = waitForDiagnostics(manager, 'python', 'main.py');
    const completions = await manager.getCompletions({
      language: 'python',
      path: 'main.py',
      content,
      version: 1,
      position: positionAfterLast(content, 'completion_tar'),
    });
    assert.ok(completions.items.some(({ label }) => label === 'completion_target'));
    await diagnosticsPromise;

    const definitions = await manager.getDefinitions({
      language: 'python',
      path: 'main.py',
      content,
      version: 2,
      position: positionInsideLast(content.slice(0, content.indexOf('completion_tar')), 'answer'),
    });
    assert.equal(definitions.locations[0]?.path, 'definition.py');
    assert.equal(definitions.locations[0]?.range.start.line, 0);

    const externalDefinitions = await manager.getDefinitions({
      language: 'python',
      path: 'main.py',
      content,
      version: 3,
      position: positionInsideLast(content, 'str'),
    });
    assert.deepEqual(externalDefinitions, { locations: [] });
  } finally {
    await manager.stop();
    removeTemporaryWorkspace(workspaceRoot);
  }
});

test('uses rust-analyzer for completions and Workspace-only definitions', {
  timeout: 60_000,
  skip: rustAnalyzerAvailable ? false : 'rust-analyzer is not installed on this machine.',
}, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'cheshi-real-rust-lsp-'));
  const sourceDirectory = path.join(workspaceRoot, 'src');
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'Cargo.toml'), [
    '[package]',
    'name = "cheshi-lsp-fixture"',
    'version = "0.0.0"',
    'edition = "2024"',
    '',
  ].join('\n'));
  writeFileSync(path.join(sourceDirectory, 'definition.rs'), 'pub fn answer() -> i32 { 42 }\n');
  const content = [
    'mod definition;',
    'fn main() {',
    '    let completion_target = definition::answer();',
    '    completion_tar',
    '    let external_value: Vec<String> = Vec::new();',
    '}',
    '',
  ].join('\n');
  writeFileSync(path.join(sourceDirectory, 'main.rs'), content);

  const manager = new LanguageServerManager({
    workspaceRoot,
    settingsPath: path.join(workspaceRoot, '.cheshi-language-servers.json'),
    clientInfo: { name: 'cheshi-real-server-test', version: '0.0.0' },
    homeDirectory: os.homedir(),
    environment: process.env,
    requestTimeoutMs: 30_000,
  });
  try {
    const initialStatus = manager.getStatuses().find(({ language }) => language === 'rust');
    assert.equal(initialStatus?.mode, 'auto');
    assert.equal(initialStatus?.state, 'available');

    const update = await manager.updateDocument({
      language: 'rust',
      path: 'src/main.rs',
      content,
      version: 1,
    });
    assert.equal(update.active, true, update.status.message);

    let version = 2;
    const completions = await waitForServerResult(() => manager.getCompletions({
      language: 'rust',
      path: 'src/main.rs',
      content,
      version: version++,
      position: positionAfterLast(content, 'completion_tar'),
    }), (result) => result.items.some(({ label }) => label === 'completion_target'), 'the completion_target completion');
    assert.ok(completions.items.some(({ label }) => label === 'completion_target'));

    // Local completions alone do not verify that cross-file definitions are ready.
    const definitions = await waitForServerResult(() => manager.getDefinitions({
      language: 'rust',
      path: 'src/main.rs',
      content,
      version: version++,
      position: positionInsideFirst(content, 'answer'),
    }), (result) => result.locations.length > 0, 'Rust workspace definitions');
    assert.equal(definitions.locations[0]?.path, 'src/definition.rs');
    assert.equal(definitions.locations[0]?.range.start.line, 0);

    const externalDefinitions = await manager.getDefinitions({
      language: 'rust',
      path: 'src/main.rs',
      content,
      version: version++,
      position: positionInsideFirst(content, 'Vec'),
    });
    assert.deepEqual(externalDefinitions, { locations: [] });
  } finally {
    await manager.stop();
    removeTemporaryWorkspace(workspaceRoot);
  }
});
