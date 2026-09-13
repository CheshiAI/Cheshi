import { parse, TomlError } from 'smol-toml';

import type { WorkspaceDiagnostic } from './workspaceDiagnostics';

function sourceOffset(content: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < content.length) {
    const lineEnd = content.indexOf('\n', offset);
    if (lineEnd < 0) return content.length;
    offset = lineEnd + 1;
    currentLine += 1;
  }
  return Math.min(offset + Math.max(column - 1, 0), content.length);
}

export function analyzeTomlSource(content: string): WorkspaceDiagnostic[] {
  try {
    parse(content);
    return [];
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    const from = sourceOffset(content, error.line, error.column);
    const to = Math.min(from + 1, content.length);
    return [{
      id: `syntax:toml:${from}:${to}`,
      kind: 'syntax',
      severity: 'error',
      message: error.message.split('\n', 1)[0] ?? 'Invalid TOML document.',
      from,
      to,
      line: error.line,
      column: error.column,
      source: 'TOML',
    }];
  }
}
