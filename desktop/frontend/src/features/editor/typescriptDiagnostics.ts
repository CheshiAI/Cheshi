import ts from 'typescript';

import type { WorkspaceDiagnostic, WorkspaceDiagnosticKind } from './workspaceDiagnostics';

const deadCodeDiagnosticCodes = new Set([
  6133,
  6138,
  6192,
  6196,
  6198,
  6199,
  6205,
  7027,
  7028,
]);

function diagnosticPosition(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

function workspaceDiagnostic(
  diagnostic: ts.Diagnostic,
  content: string,
  kind: WorkspaceDiagnosticKind,
): WorkspaceDiagnostic {
  const from = Math.max(0, Math.min(diagnostic.start ?? 0, content.length));
  const to = Math.max(from, Math.min(from + (diagnostic.length ?? 0), content.length));
  const position = diagnosticPosition(content, from);
  return {
    id: `${kind}:typescript:${diagnostic.code}:${from}:${to}`,
    kind,
    severity: kind === 'syntax' ? 'error' : 'warning',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    from,
    to,
    ...position,
    source: 'TypeScript',
    code: diagnostic.code,
  };
}

function isDeprecatedDiagnostic(diagnostic: ts.Diagnostic): boolean {
  return diagnostic.reportsDeprecated === true;
}

export function analyzeTypeScriptSource(path: string, content: string): WorkspaceDiagnostic[] {
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    allowUnreachableCode: false,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host: ts.LanguageServiceHost = {
    fileExists: (fileName) => fileName === path,
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => 'lib.d.ts',
    getScriptFileNames: () => [path],
    getScriptSnapshot: (fileName) => (
      fileName === path ? ts.ScriptSnapshot.fromString(content) : undefined
    ),
    getScriptVersion: () => '0',
    readDirectory: () => [],
    readFile: (fileName) => fileName === path ? content : undefined,
    useCaseSensitiveFileNames: () => true,
  };
  const service = ts.createLanguageService(host);

  try {
    const diagnostics: WorkspaceDiagnostic[] = service
      .getSyntacticDiagnostics(path)
      .map((diagnostic) => workspaceDiagnostic(diagnostic, content, 'syntax'));
    const semanticDiagnostics = [
      ...service.getSemanticDiagnostics(path),
      ...service.getSuggestionDiagnostics(path),
    ];
    for (const diagnostic of semanticDiagnostics) {
      if (isDeprecatedDiagnostic(diagnostic)) {
        diagnostics.push(workspaceDiagnostic(diagnostic, content, 'deprecated'));
      } else if (deadCodeDiagnosticCodes.has(diagnostic.code)) {
        diagnostics.push(workspaceDiagnostic(diagnostic, content, 'dead-code'));
      }
    }

    const unique = new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic]));
    return [...unique.values()].sort((left, right) => (
      left.from - right.from || left.to - right.to || left.kind.localeCompare(right.kind)
    ));
  } finally {
    service.dispose();
  }
}
