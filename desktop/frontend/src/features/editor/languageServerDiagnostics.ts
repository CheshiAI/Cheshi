import type {
  LanguageServerCompletionItem,
  LanguageServerCompletionResult,
  LanguageServerCodeAction,
  LanguageServerCodeActionResult,
  LanguageServerDefinitionResult,
  LanguageServerDiagnostic,
  LanguageServerDiagnosticsEvent,
  LanguageServerDocumentUpdateResult,
  LanguageServerHoverResult,
  LanguageServerLanguage,
  LanguageServerLocation,
  LanguageServerMode,
  LanguageServerPosition,
  LanguageServerPrepareRenameResult,
  LanguageServerRange,
  LanguageServerReferenceResult,
  LanguageServerRenameResult,
  LanguageServerSignature,
  LanguageServerSignatureHelpResult,
  LanguageServerState,
  LanguageServerStatus,
  LanguageServerTextEdit,
  LanguageServerWorkspaceEdit,
} from '../../cheshiDesktop';
import type { WorkspaceDiagnostic, WorkspaceDiagnosticKind } from './workspaceDiagnostics';

const languageServerModes = new Set<LanguageServerMode>(['auto', 'custom', 'disabled']);
const languageServerStates = new Set<LanguageServerState>(['available', 'disabled', 'error', 'missing', 'running']);
const typescriptLanguageServerExtensions = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLanguage(value: unknown): value is LanguageServerLanguage {
  return value === 'rust' || value === 'typescript' || value === 'python';
}

function normalizeStatus(value: unknown): LanguageServerStatus | null {
  if (!isRecord(value) || !isLanguage(value.language)) return null;
  if (typeof value.displayName !== 'string' || !value.displayName) return null;
  if (typeof value.serverName !== 'string' || !value.serverName) return null;
  if (typeof value.mode !== 'string' || !languageServerModes.has(value.mode as LanguageServerMode)) return null;
  if (typeof value.state !== 'string' || !languageServerStates.has(value.state as LanguageServerState)) return null;
  if (value.executable !== null && typeof value.executable !== 'string') return null;
  if (typeof value.message !== 'string') return null;
  return {
    language: value.language,
    displayName: value.displayName,
    serverName: value.serverName,
    mode: value.mode as LanguageServerMode,
    state: value.state as LanguageServerState,
    executable: value.executable,
    message: value.message,
  };
}

export function normalizeLanguageServerStatuses(value: unknown): LanguageServerStatus[] | null {
  if (!Array.isArray(value)) return null;
  const statuses = value.map(normalizeStatus);
  return statuses.every((status): status is LanguageServerStatus => status !== null) ? statuses : null;
}

export function normalizeLanguageServerUpdateResult(value: unknown): LanguageServerDocumentUpdateResult | null {
  if (!isRecord(value) || (value.active !== true && value.active !== false)) return null;
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) return null;
  const status = normalizeStatus(value.status);
  if (!status) return null;
  return { active: value.active, version: Number(value.version), status };
}

export function normalizeLanguageServerSelectionResult(value: unknown): {
  canceled: boolean;
  statuses: LanguageServerStatus[];
} | null {
  if (!isRecord(value) || (value.canceled !== true && value.canceled !== false)) return null;
  const statuses = normalizeLanguageServerStatuses(value.statuses);
  return statuses ? { canceled: value.canceled, statuses } : null;
}

export function normalizeLanguageServerDiagnosticsEvent(value: unknown): LanguageServerDiagnosticsEvent | null {
  if (!isRecord(value) || !isLanguage(value.language)) return null;
  if (typeof value.path !== 'string' || !value.path) return null;
  if (value.version !== null && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) return null;
  if (!Array.isArray(value.diagnostics)) return null;
  return {
    language: value.language,
    path: value.path,
    version: value.version === null ? null : Number(value.version),
    diagnostics: value.diagnostics,
  };
}

export function isJavaScriptOrTypeScriptPath(filePath: string): boolean {
  const extension = filePath.toLocaleLowerCase().split('.').at(-1) ?? '';
  return typescriptLanguageServerExtensions.has(extension);
}

export function languageServerLanguageForPath(filePath: string): LanguageServerLanguage | null {
  const extension = filePath.toLocaleLowerCase().split('.').at(-1) ?? '';
  if (extension === 'rs') return 'rust';
  if (isJavaScriptOrTypeScriptPath(filePath)) return 'typescript';
  if (extension === 'py' || extension === 'pyi') return 'python';
  return null;
}

function diagnosticValue(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (!isRecord(value)) return undefined;
  return typeof value.value === 'string' || typeof value.value === 'number' ? value.value : undefined;
}

function normalizeLanguageServerPosition(value: unknown): LanguageServerPosition | null {
  if (!isRecord(value)) return null;
  if (!Number.isSafeInteger(value.line) || Number(value.line) < 0) return null;
  if (!Number.isSafeInteger(value.character) || Number(value.character) < 0) return null;
  return { line: Number(value.line), character: Number(value.character) };
}

function normalizeLanguageServerRange(value: unknown): LanguageServerRange | null {
  if (!isRecord(value)) return null;
  const start = normalizeLanguageServerPosition(value.start);
  const end = normalizeLanguageServerPosition(value.end);
  return start && end ? { start, end } : null;
}

export function normalizeLanguageServerDiagnostic(value: unknown): LanguageServerDiagnostic | null {
  if (!isRecord(value) || !isRecord(value.range) || typeof value.message !== 'string') return null;
  const range = normalizeLanguageServerRange(value.range);
  if (!range) return null;
  const severity = Number.isSafeInteger(value.severity) ? Number(value.severity) : undefined;
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is number => Number.isSafeInteger(tag)).map(Number)
    : undefined;
  return {
    range,
    message: value.message,
    ...(severity === undefined ? {} : { severity }),
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    ...(tags === undefined ? {} : { tags }),
  };
}

function normalizeCompletionItem(value: unknown): LanguageServerCompletionItem | null {
  if (!isRecord(value) || typeof value.label !== 'string' || !value.label) return null;
  if (value.detail !== null && typeof value.detail !== 'string') return null;
  if (value.documentation !== null && typeof value.documentation !== 'string') return null;
  if (value.kind !== null && !Number.isSafeInteger(value.kind)) return null;
  if (value.sortText !== null && typeof value.sortText !== 'string') return null;
  if (value.filterText !== null && typeof value.filterText !== 'string') return null;
  if (typeof value.insertText !== 'string') return null;
  if (value.deprecated !== true && value.deprecated !== false) return null;
  if (!Array.isArray(value.commitCharacters) || !value.commitCharacters.every((entry) => typeof entry === 'string')) {
    return null;
  }
  let textEdit = null;
  if (value.textEdit !== null) {
    if (!isRecord(value.textEdit) || typeof value.textEdit.newText !== 'string') return null;
    const range = normalizeLanguageServerRange(value.textEdit.range);
    if (!range) return null;
    textEdit = { range, newText: value.textEdit.newText };
  }
  return {
    label: value.label,
    detail: value.detail,
    documentation: value.documentation,
    kind: value.kind === null ? null : Number(value.kind),
    sortText: value.sortText,
    filterText: value.filterText,
    insertText: value.insertText,
    textEdit,
    deprecated: value.deprecated,
    commitCharacters: value.commitCharacters,
  };
}

export function normalizeLanguageServerCompletionResult(value: unknown): LanguageServerCompletionResult | null {
  if (!isRecord(value) || (value.isIncomplete !== true && value.isIncomplete !== false)) return null;
  if (!Array.isArray(value.items)) return null;
  const items = value.items.map(normalizeCompletionItem);
  if (!items.every((item): item is LanguageServerCompletionItem => item !== null)) return null;
  return { isIncomplete: value.isIncomplete, items };
}

export function normalizeLanguageServerHoverResult(value: unknown): LanguageServerHoverResult | null {
  if (!isRecord(value) || !Array.isArray(value.contents)) return null;
  if (!value.contents.every((content) => typeof content === 'string')) return null;
  let range = null;
  if (value.range !== null) {
    range = normalizeLanguageServerRange(value.range);
    if (!range) return null;
  }
  return { contents: value.contents, range };
}

function normalizeLanguageServerLocation(value: unknown): LanguageServerLocation | null {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path) return null;
  const range = normalizeLanguageServerRange(value.range);
  return range ? { path: value.path, range } : null;
}

export function normalizeLanguageServerDefinitionResult(value: unknown): LanguageServerDefinitionResult | null {
  if (!isRecord(value) || !Array.isArray(value.locations)) return null;
  const locations = value.locations.map(normalizeLanguageServerLocation);
  if (!locations.every((location): location is LanguageServerLocation => location !== null)) return null;
  return { locations };
}

export function normalizeLanguageServerReferenceResult(value: unknown): LanguageServerReferenceResult | null {
  return normalizeLanguageServerDefinitionResult(value);
}

function normalizeLanguageServerSignature(value: unknown): LanguageServerSignature | null {
  if (!isRecord(value) || typeof value.label !== 'string' || !value.label) return null;
  if (value.documentation !== null && typeof value.documentation !== 'string') return null;
  if (!Array.isArray(value.parameters)) return null;
  if (value.activeParameter !== null && (!Number.isSafeInteger(value.activeParameter) || Number(value.activeParameter) < 0)) {
    return null;
  }
  const parameters = value.parameters.map((parameter) => {
    if (!isRecord(parameter) || typeof parameter.label !== 'string') return null;
    if (parameter.documentation !== null && typeof parameter.documentation !== 'string') return null;
    return { label: parameter.label, documentation: parameter.documentation };
  });
  if (!parameters.every((parameter): parameter is LanguageServerSignature['parameters'][number] => parameter !== null)) {
    return null;
  }
  return {
    label: value.label,
    documentation: value.documentation,
    parameters,
    activeParameter: value.activeParameter === null ? null : Number(value.activeParameter),
  };
}

export function normalizeLanguageServerSignatureHelpResult(value: unknown): LanguageServerSignatureHelpResult | null {
  if (!isRecord(value) || !Array.isArray(value.signatures)) return null;
  if (value.activeSignature !== null && (!Number.isSafeInteger(value.activeSignature) || Number(value.activeSignature) < 0)) {
    return null;
  }
  if (value.activeParameter !== null && (!Number.isSafeInteger(value.activeParameter) || Number(value.activeParameter) < 0)) {
    return null;
  }
  const signatures = value.signatures.map(normalizeLanguageServerSignature);
  if (!signatures.every((signature): signature is LanguageServerSignature => signature !== null)) return null;
  return {
    signatures,
    activeSignature: value.activeSignature === null ? null : Number(value.activeSignature),
    activeParameter: value.activeParameter === null ? null : Number(value.activeParameter),
  };
}

function normalizeLanguageServerTextEdit(value: unknown): LanguageServerTextEdit | null {
  if (!isRecord(value) || typeof value.newText !== 'string') return null;
  const range = normalizeLanguageServerRange(value.range);
  return range ? { range, newText: value.newText } : null;
}

function normalizeLanguageServerWorkspaceEdit(value: unknown): LanguageServerWorkspaceEdit | null {
  if (!isRecord(value) || !Array.isArray(value.files)) return null;
  const files = value.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string' || !file.path || !Array.isArray(file.edits)) return null;
    const edits = file.edits.map(normalizeLanguageServerTextEdit);
    if (!edits.every((edit): edit is LanguageServerTextEdit => edit !== null)) return null;
    return { path: file.path, edits };
  });
  return files.every((file): file is LanguageServerWorkspaceEdit['files'][number] => file !== null)
    ? { files }
    : null;
}

function normalizeLanguageServerCodeAction(value: unknown): LanguageServerCodeAction | null {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title) return null;
  if (value.kind !== null && typeof value.kind !== 'string') return null;
  if (value.preferred !== true && value.preferred !== false) return null;
  if (value.disabledReason !== null && typeof value.disabledReason !== 'string') return null;
  let edit = null;
  if (value.edit !== null) {
    edit = normalizeLanguageServerWorkspaceEdit(value.edit);
    if (!edit) return null;
  }
  return {
    title: value.title,
    kind: value.kind,
    preferred: value.preferred,
    disabledReason: value.disabledReason,
    edit,
  };
}

export function normalizeLanguageServerCodeActionResult(value: unknown): LanguageServerCodeActionResult | null {
  if (!isRecord(value) || !Array.isArray(value.actions)) return null;
  const actions = value.actions.map(normalizeLanguageServerCodeAction);
  return actions.every((action): action is LanguageServerCodeAction => action !== null) ? { actions } : null;
}

export function normalizeLanguageServerPrepareRenameResult(value: unknown): LanguageServerPrepareRenameResult | null {
  if (!isRecord(value)) return null;
  if (value.available !== true && value.available !== false) return null;
  if (value.placeholder !== null && typeof value.placeholder !== 'string') return null;
  let range = null;
  if (value.range !== null) {
    range = normalizeLanguageServerRange(value.range);
    if (!range) return null;
  }
  if (!value.available && (range !== null || value.placeholder !== null)) return null;
  return { available: value.available, range, placeholder: value.placeholder };
}

export function normalizeLanguageServerRenameResult(value: unknown): LanguageServerRenameResult | null {
  if (!isRecord(value)) return null;
  if (value.failureReason !== null && typeof value.failureReason !== 'string') return null;
  let edit = null;
  if (value.edit !== null) {
    edit = normalizeLanguageServerWorkspaceEdit(value.edit);
    if (!edit) return null;
  }
  return { edit, failureReason: value.failureReason };
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionOffset(content: string, starts: readonly number[], line: number, character: number): number {
  const lineIndex = Math.min(line, starts.length - 1);
  const start = starts[lineIndex] ?? 0;
  let end = starts[lineIndex + 1] ?? content.length;
  if (end > start && content.charCodeAt(end - 1) === 10) end -= 1;
  if (end > start && content.charCodeAt(end - 1) === 13) end -= 1;
  return Math.min(start + character, end);
}

function diagnosticKind(diagnostic: LanguageServerDiagnostic): WorkspaceDiagnosticKind {
  if (diagnostic.tags?.includes(2)) return 'deprecated';
  if (diagnostic.tags?.includes(1)) return 'dead-code';
  return 'syntax';
}

function diagnosticSeverity(value: number | undefined): WorkspaceDiagnostic['severity'] {
  if (value === 1) return 'error';
  if (value === 3) return 'info';
  return value === 4 ? 'info' : 'warning';
}

export function workspaceDiagnosticsFromLanguageServer(
  values: readonly unknown[],
  content: string,
  serverName: string,
): WorkspaceDiagnostic[] {
  const starts = lineStarts(content);
  const diagnostics: WorkspaceDiagnostic[] = [];
  values.forEach((value, index) => {
    const diagnostic = normalizeLanguageServerDiagnostic(value);
    if (!diagnostic) return;
    const from = positionOffset(
      content,
      starts,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
    );
    const rawTo = positionOffset(
      content,
      starts,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
    );
    const to = Math.max(from, rawTo);
    const lineStart = starts[Math.min(diagnostic.range.start.line, starts.length - 1)] ?? 0;
    const kind = diagnosticKind(diagnostic);
    const code = diagnosticValue(diagnostic.code);
    diagnostics.push({
      id: `${kind}:lsp:${diagnostic.source ?? serverName}:${code ?? ''}:${from}:${to}:${index}`,
      kind,
      severity: diagnosticSeverity(diagnostic.severity),
      message: diagnostic.message,
      from,
      to,
      line: Math.min(diagnostic.range.start.line, starts.length - 1) + 1,
      column: from - lineStart + 1,
      source: diagnostic.source || serverName,
      ...(code === undefined ? {} : { code }),
    });
  });
  return diagnostics.sort((left, right) => (
    left.from - right.from || left.to - right.to || left.kind.localeCompare(right.kind)
  ));
}
