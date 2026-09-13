import assert from 'node:assert/strict';

import { describe, expect, it } from 'bun:test';

import { analyzeTypeScriptSource } from '../frontend/src/features/editor/typescriptDiagnostics';
import { analyzeTomlSource } from '../frontend/src/features/editor/tomlDiagnostics';
import {
  languageServerLanguageForPath,
  normalizeLanguageServerCodeActionResult,
  normalizeLanguageServerCompletionResult,
  normalizeLanguageServerDefinitionResult,
  normalizeLanguageServerHoverResult,
  normalizeLanguageServerPrepareRenameResult,
  normalizeLanguageServerReferenceResult,
  normalizeLanguageServerRenameResult,
  normalizeLanguageServerSignatureHelpResult,
  workspaceDiagnosticsFromLanguageServer,
} from '../frontend/src/features/editor/languageServerDiagnostics';
import { toCodeMirrorDiagnostics } from '../frontend/src/features/editor/workspaceDiagnostics';
import { fileRefactoringRecommendation } from '../frontend/src/features/editor/workspaceRefactoring';

describe('workspace editor diagnostics', () => {
  it('recommends refactoring only when the current draft exceeds one thousand lines', () => {
    const content = Array.from({ length: 1_000 }, () => 'const value = 1;').join('\n');

    expect(fileRefactoringRecommendation('')).toBeNull();
    expect(fileRefactoringRecommendation('x'.repeat(100_000))).toBeNull();
    expect(fileRefactoringRecommendation(content)).toBeNull();
    expect(fileRefactoringRecommendation(`${content}\nconst extra = 2;`)).toBe(
      'This file has 1,001 lines (recommended maximum: 1,000). Consider splitting it into smaller files by responsibility.',
    );
    expect(fileRefactoringRecommendation(content)).toBeNull();
  });

  it.each(['\n', '\r\n', '\r'])('counts physical lines with %j line endings', (lineEnding) => {
    const content = Array.from({ length: 1_000 }, () => 'line').join(lineEnding);

    expect(fileRefactoringRecommendation(content + lineEnding)).toBeNull();
    expect(fileRefactoringRecommendation(content + lineEnding + lineEnding)).toContain('1,001 lines');
    expect(fileRefactoringRecommendation(content + lineEnding + 'extra' + lineEnding)).toContain('1,001 lines');
  });

  it('excludes bun lockfiles without excluding source files with similar paths', () => {
    const content = 'line\n'.repeat(1_001);
    for (const path of ['bun.lock', 'packages/app/bun.lock', '/workspace/bun.lock', 'C:\\workspace\\bun.lock']) {
      expect(fileRefactoringRecommendation(content, path)).toBeNull();
    }
    for (const path of ['src/app.ts', 'bun.lock.ts', 'bun.lock/source.ts', 'my-bun.lock']) {
      expect(fileRefactoringRecommendation(content, path)).toContain('1,001 lines');
    }
  });

  it('reports syntax errors with source positions', () => {
    const diagnostics = analyzeTypeScriptSource('src/broken.ts', 'const value = ;\n');
    const syntax = diagnostics.find((diagnostic) => diagnostic.kind === 'syntax');

    expect(syntax).toBeDefined();
    expect(syntax?.line).toBe(1);
    expect(syntax?.column).toBeGreaterThan(1);
  });

  it('reports deprecated symbol usage', () => {
    const diagnostics = analyzeTypeScriptSource('src/deprecated.ts', [
      '/** @deprecated Use currentApi instead. */',
      'function legacyApi() {}',
      'legacyApi();',
    ].join('\n'));

    expect(diagnostics.some((diagnostic) => diagnostic.kind === 'deprecated')).toBe(true);
  });

  it('reports unused and unreachable code', () => {
    const diagnostics = analyzeTypeScriptSource('src/dead-code.ts', [
      'export {};',
      'const unused = 1;',
      'function run() {',
      '  return;',
      '  work();',
      '}',
      'run();',
    ].join('\n'));
    const deadCodeDiagnostics = diagnostics.filter((diagnostic) => diagnostic.kind === 'dead-code');

    expect(deadCodeDiagnostics.some((diagnostic) => diagnostic.code === 6133)).toBe(true);
    expect(deadCodeDiagnostics.some((diagnostic) => diagnostic.code === 7027)).toBe(true);
  });

  it('reports TOML syntax errors with parser positions', () => {
    expect(analyzeTomlSource('[install]\nlinker = "hoisted"\n')).toEqual([]);

    const diagnostics = analyzeTomlSource('[install\nlinker = "hoisted"\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe('syntax');
    expect(diagnostics[0]?.line).toBe(1);
    expect(diagnostics[0]?.column).toBe(2);
  });

  it('maps LSP diagnostics and UTF-16 positions into editor diagnostics', () => {
    const content = 'const 😀value = 1;\n';
    const diagnostics = workspaceDiagnosticsFromLanguageServer([{
      range: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } },
      severity: 2,
      code: 'unused-value',
      source: 'fixture-lsp',
      tags: [1],
      message: 'value is unused',
    }], content, 'fallback-lsp');

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.from).toBe(8);
    expect(diagnostics[0]?.to).toBe(13);
    expect(diagnostics[0]?.column).toBe(9);
    expect(diagnostics[0]?.kind).toBe('dead-code');
    expect(diagnostics[0]?.code).toBe('unused-value');
  });

  it('selects LSP support for Rust, JavaScript and TypeScript, and Python files', () => {
    expect(languageServerLanguageForPath('src/main.rs')).toBe('rust');
    expect(languageServerLanguageForPath('src/app.js')).toBe('typescript');
    expect(languageServerLanguageForPath('src/app.jsx')).toBe('typescript');
    expect(languageServerLanguageForPath('src/app.mjs')).toBe('typescript');
    expect(languageServerLanguageForPath('src/app.cjs')).toBe('typescript');
    expect(languageServerLanguageForPath('src/app.ts')).toBe('typescript');
    expect(languageServerLanguageForPath('src/app.tsx')).toBe('typescript');
    expect(languageServerLanguageForPath('src/app.mts')).toBe('typescript');
    expect(languageServerLanguageForPath('src/app.cts')).toBe('typescript');
    expect(languageServerLanguageForPath('src/tool.py')).toBe('python');
    expect(languageServerLanguageForPath('src/tool.pyi')).toBe('python');
    expect(languageServerLanguageForPath('README.md')).toBeNull();
  });

  it('validates editor language feature responses from the desktop boundary', () => {
    expect(normalizeLanguageServerCompletionResult({
      isIncomplete: false,
      items: [{
        label: 'run',
        detail: 'function',
        documentation: 'Runs the task.',
        kind: 3,
        sortText: '001',
        filterText: 'run',
        insertText: 'run()',
        textEdit: {
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 6 } },
          newText: 'run()',
        },
        deprecated: false,
        commitCharacters: ['.'],
      }],
    })?.items[0]?.insertText).toBe('run()');

    expect(normalizeLanguageServerHoverResult({
      contents: ['```typescript\nfunction run(): void\n```', 'Runs the task.'],
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
    })?.contents).toEqual(['```typescript\nfunction run(): void\n```', 'Runs the task.']);
    expect(normalizeLanguageServerHoverResult({ contents: [null], range: null })).toBeNull();

    expect(normalizeLanguageServerDefinitionResult({
      locations: [{
        path: 'src/task.ts',
        range: { start: { line: 8, character: 2 }, end: { line: 8, character: 5 } },
      }],
    })?.locations[0]?.path).toBe('src/task.ts');
    expect(normalizeLanguageServerDefinitionResult({ locations: [{ path: '', range: {} }] })).toBeNull();

    expect(normalizeLanguageServerReferenceResult({
      locations: [{
        path: 'src/task.ts',
        range: { start: { line: 3, character: 1 }, end: { line: 3, character: 4 } },
      }],
    })?.locations).toHaveLength(1);

    expect(normalizeLanguageServerSignatureHelpResult({
      signatures: [{
        label: 'run(value: string): void',
        documentation: 'Runs the task.',
        parameters: [{ label: 'value: string', documentation: 'Task value.' }],
        activeParameter: null,
      }],
      activeSignature: 0,
      activeParameter: 0,
    })?.signatures[0]?.parameters[0]?.label).toBe('value: string');

    const workspaceEdit = {
      files: [{
        path: 'src/task.ts',
        edits: [{
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
          newText: 'updated',
        }],
      }],
    };
    expect(normalizeLanguageServerCodeActionResult({
      actions: [{
        title: 'Update task',
        kind: 'quickfix',
        preferred: true,
        disabledReason: null,
        edit: workspaceEdit,
      }],
    })?.actions[0]?.edit).toEqual(workspaceEdit);
    const renameRange = {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 5 },
    };
    assert.deepStrictEqual(normalizeLanguageServerPrepareRenameResult({
      available: true,
      range: renameRange,
      placeholder: 'task',
    }), { available: true, range: renameRange, placeholder: 'task' });
    assert.deepStrictEqual(normalizeLanguageServerPrepareRenameResult({
      available: false,
      range: null,
      placeholder: null,
    }), { available: false, range: null, placeholder: null });
    expect(normalizeLanguageServerPrepareRenameResult({
      range: null,
      placeholder: null,
    })).toBeNull();
    expect(normalizeLanguageServerRenameResult({ edit: workspaceEdit, failureReason: null })?.edit).toEqual(workspaceEdit);
    expect(normalizeLanguageServerRenameResult({ edit: { files: [{ path: '', edits: [] }] }, failureReason: null })).toBeNull();
  });

  it('maps diagnostic kinds to statically discoverable editor mark classes', () => {
    const kinds = ['syntax', 'deprecated', 'dead-code'] as const;
    const diagnostics = toCodeMirrorDiagnostics(kinds.map((kind, index) => ({
      id: kind,
      kind,
      severity: 'warning',
      message: kind,
      from: index,
      to: index + 1,
      line: 1,
      column: index + 1,
      source: 'test',
    })));

    expect(diagnostics.map((diagnostic) => diagnostic.markClass)).toEqual([
      'workspace-editor-diagnostic-syntax',
      'workspace-editor-diagnostic-deprecated',
      'workspace-editor-diagnostic-dead-code',
    ]);
  });
});
