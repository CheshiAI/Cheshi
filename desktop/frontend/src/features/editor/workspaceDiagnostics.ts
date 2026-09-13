import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { Diagnostic as CodeMirrorDiagnostic } from '@codemirror/lint';
import type { EditorState } from '@codemirror/state';

export type WorkspaceDiagnosticKind = 'syntax' | 'deprecated' | 'dead-code';
export type WorkspaceDiagnosticsStatus = 'checking' | 'ready' | 'unsupported' | 'error';

export const workspaceDiagnosticMarkClasses: Record<WorkspaceDiagnosticKind, string> = {
  syntax: 'workspace-editor-diagnostic-syntax',
  deprecated: 'workspace-editor-diagnostic-deprecated',
  'dead-code': 'workspace-editor-diagnostic-dead-code',
};

export interface WorkspaceDiagnostic {
  id: string;
  kind: WorkspaceDiagnosticKind;
  severity: 'error' | 'warning' | 'info';
  message: string;
  from: number;
  to: number;
  line: number;
  column: number;
  source: string;
  code?: string | number;
}

export interface WorkspaceDiagnosticsWorkerRequest {
  requestId: number;
  path: string;
  content: string;
  engine: 'typescript' | 'toml';
}

export type WorkspaceDiagnosticsWorkerResponse = {
  requestId: number;
  path: string;
  diagnostics: WorkspaceDiagnostic[];
  error?: never;
} | {
  requestId: number;
  path: string;
  diagnostics?: never;
  error: string;
};

function parserDiagnostic(state: EditorState, from: number, to: number): WorkspaceDiagnostic {
  const line = state.doc.lineAt(Math.min(from, state.doc.length));
  const end = Math.max(from, Math.min(to, state.doc.length));
  return {
    id: `syntax:codemirror:${from}:${end}`,
    kind: 'syntax',
    severity: 'error',
    message: 'Syntax error or incomplete expression.',
    from,
    to: end,
    line: line.number,
    column: from - line.from + 1,
    source: 'CodeMirror',
  };
}

export function collectParserDiagnostics(state: EditorState): WorkspaceDiagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const diagnostics: WorkspaceDiagnostic[] = [];
  const ranges = new Set<string>();
  const cursor = tree.cursor();

  do {
    if (!cursor.type.isError) continue;
    const range = `${cursor.from}:${cursor.to}`;
    if (ranges.has(range)) continue;
    ranges.add(range);
    diagnostics.push(parserDiagnostic(state, cursor.from, cursor.to));
  } while (cursor.next());

  return diagnostics;
}

export function toCodeMirrorDiagnostics(
  diagnostics: readonly WorkspaceDiagnostic[],
): CodeMirrorDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    source: diagnostic.source,
    message: diagnostic.message,
    markClass: workspaceDiagnosticMarkClasses[diagnostic.kind],
  }));
}
