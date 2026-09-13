import type { Completion } from '@codemirror/autocomplete';
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import type { LanguageSupport } from '@codemirror/language';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, showTooltip, type Tooltip } from '@codemirror/view';

import {
  cheshiDesktop as workspace,
  type LanguageServerCompletionItem,
  type LanguageServerHoverResult,
  type LanguageServerLanguage,
  type LanguageServerPosition,
  type LanguageServerRange,
  type LanguageServerRenameResult,
  type LanguageServerSignatureHelpResult,
  type LanguageServerStatus,
  type LanguageServerWorkspaceEdit,
  type WorkspaceFileExcerptResult,
  type WorkspaceFileVersion,
  type WorkspaceFilesWriteResult,
} from '../../cheshiDesktop';
import { isJavaScriptOrTypeScriptPath } from './languageServerDiagnostics';
import { applyLanguageServerTextEdits } from './workspaceTextEdits';

export interface WorkspaceTab {
  path: string;
  file: WorkspaceFileVersion;
  previewDataUrl: string | null;
  sourceExcerpt: WorkspaceFileExcerptResult | null;
  savedContent: string;
  draftContent: string;
  conflictMessage: string | null;
  loadGeneration: number;
  editorState?: EditorState;
}

export type WorkspaceDiagnosticMode = 'typescript' | 'toml' | 'parser' | 'unsupported';

export interface LanguageServerExpectation {
  language: LanguageServerLanguage;
  path: string;
  requestId: number;
  version: number;
  diagnosticsApplied: boolean;
}

export interface DefinitionLinkRange {
  from: number;
  to: number;
}

export interface NavigationLocation {
  path: string;
  line: number;
  character: number;
}

export interface PreparedWorkspaceEditFile {
  path: string;
  originalContent: string;
  nextContent: string;
  file: WorkspaceFileVersion;
  previews: ReturnType<typeof applyLanguageServerTextEdits>['previews'];
}

export interface PreparedWorkspaceEdit {
  title: string;
  files: PreparedWorkspaceEditFile[];
}

export const setDefinitionLinkRange = StateEffect.define<DefinitionLinkRange | null>();
const definitionLinkDecoration = Decoration.mark({ class: 'workspace-editor-definition-link' });
export const definitionLinkRangeField = StateField.define<DefinitionLinkRange | null>({
  create: () => null,
  update: (current, transaction) => {
    let next = current;
    if (next && transaction.docChanged) {
      const from = transaction.changes.mapPos(next.from, 1);
      const to = transaction.changes.mapPos(next.to, -1);
      next = from < to ? { from, to } : null;
    }
    for (const effect of transaction.effects) {
      if (effect.is(setDefinitionLinkRange)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (range) => (
    range
      ? Decoration.set([definitionLinkDecoration.range(range.from, range.to)])
      : Decoration.none
  )),
});

export const setSignatureHelpTooltip = StateEffect.define<Tooltip | null>();
export const signatureHelpTooltipField = StateField.define<Tooltip | null>({
  create: () => null,
  update: (current, transaction) => {
    let next = current;
    for (const effect of transaction.effects) {
      if (effect.is(setSignatureHelpTooltip)) next = effect.value;
    }
    return next;
  },
  provide: (field) => showTooltip.from(field),
});

export const LANGUAGE_SERVER_FALLBACK_DELAY_MS = 5_000;
export const SOURCE_EXCERPT_CONTEXT_LINES = 80;
export const REFERENCE_PREVIEW_CONTEXT_LINES = 3;
export const MAX_NAVIGATION_HISTORY = 100;

const languageServerCompletionTypes = new Map<number, string>([
  [1, 'text'],
  [2, 'method'],
  [3, 'function'],
  [4, 'constructor'],
  [5, 'property'],
  [6, 'variable'],
  [7, 'class'],
  [8, 'interface'],
  [9, 'namespace'],
  [10, 'property'],
  [11, 'unit'],
  [12, 'value'],
  [13, 'enum'],
  [14, 'keyword'],
  [15, 'snippet'],
  [16, 'color'],
  [17, 'file'],
  [18, 'reference'],
  [19, 'folder'],
  [20, 'enum-member'],
  [21, 'constant'],
  [22, 'struct'],
  [23, 'event'],
  [24, 'operator'],
  [25, 'type-parameter'],
]);

const parserDiagnosticExtensions = new Set([
  'c', 'cc', 'cpp', 'css', 'cxx', 'go', 'h', 'hpp', 'htm', 'html', 'java', 'json',
  'php', 'py', 'pyi', 'rs', 'svg', 'xhtml', 'xml', 'yaml', 'yml',
]);

function fileExtension(filePath: string): string {
  return filePath.toLocaleLowerCase().split('.').at(-1) ?? '';
}

export function assertLanguageServerValue<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
}

export function assertSourceExcerptReaderAvailable<T>(reader: T): asserts reader is NonNullable<T> {
  if (reader === null || reader === undefined) {
    throw new Error('Electron source excerpt API is unavailable.');
  }
}

export function requireLanguageServerRenameEdit(
  response: LanguageServerRenameResult,
): LanguageServerWorkspaceEdit {
  if (!response.edit) throw new Error(response.failureReason ?? 'Rename is unavailable here.');
  return response.edit;
}

export function assertWorkspaceEditPreviewCurrent(
  file: PreparedWorkspaceEditFile,
  tab: WorkspaceTab | undefined,
): void {
  if (tab && (tab.file.revision !== file.file.revision || tab.draftContent !== file.originalContent)) {
    throw new Error(`The edit preview for ${file.path} is stale. Preview the change again.`);
  }
}

export function assertWorkspaceFilesWritten(response: WorkspaceFilesWriteResult): void {
  if (response.status !== 'conflict') return;
  const conflictPaths = response.files.map((file) => file.path).join(', ');
  throw new Error(`Files changed before the edit could be applied: ${conflictPaths}`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function tabLabel(tab: WorkspaceTab): string {
  return tab.path.split('/').at(-1) ?? tab.path;
}

export function isTabDirty(tab: WorkspaceTab): boolean {
  return tab.draftContent !== tab.savedContent;
}

export function languageSupport(filePath: string): LanguageSupport | null {
  const extension = fileExtension(filePath);
  if (isJavaScriptOrTypeScriptPath(filePath)) {
    return javascript({
      typescript: ['ts', 'tsx', 'mts', 'cts'].includes(extension),
      jsx: extension === 'jsx' || extension === 'tsx',
    });
  }
  if (extension === 'json' || extension === 'jsonc') return json();
  if (extension === 'html' || extension === 'htm') return html();
  if (extension === 'css' || extension === 'scss' || extension === 'less') return css();
  if (extension === 'md' || extension === 'markdown') return markdown();
  if (extension === 'py' || extension === 'pyi') return python();
  if (extension === 'rs') return rust();
  if (extension === 'go') return go();
  if (extension === 'java') return java();
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hpp'].includes(extension)) return cpp();
  if (extension === 'php') return php();
  if (extension === 'xml' || extension === 'xhtml' || extension === 'svg') return xml();
  if (extension === 'yaml' || extension === 'yml') return yaml();
  return null;
}

export function diagnosticMode(
  filePath: string,
  language: LanguageSupport | null,
): WorkspaceDiagnosticMode {
  const extension = fileExtension(filePath);
  if (isJavaScriptOrTypeScriptPath(filePath)) return 'typescript';
  if (extension === 'toml') return 'toml';
  if (language && parserDiagnosticExtensions.has(extension)) return 'parser';
  return 'unsupported';
}

export function canUseLanguageServer(
  language: LanguageServerLanguage,
  statuses: readonly LanguageServerStatus[],
): boolean {
  const status = statuses.find((entry) => entry.language === language);
  return status?.state === 'available' || status?.state === 'running';
}

export function languageServerPositionAt(
  view: EditorView,
  offset: number,
): LanguageServerPosition {
  const line = view.state.doc.lineAt(Math.min(Math.max(offset, 0), view.state.doc.length));
  return { line: line.number - 1, character: offset - line.from };
}

export function editorOffsetAt(view: EditorView, position: LanguageServerPosition): number {
  const line = view.state.doc.line(Math.min(position.line + 1, view.state.doc.lines));
  return Math.min(line.from + position.character, line.to);
}

export function languageServerSelectionRange(view: EditorView): LanguageServerRange {
  const selection = view.state.selection.main;
  return {
    start: languageServerPositionAt(view, selection.from),
    end: languageServerPositionAt(view, selection.to),
  };
}

function completionType(kind: number | null): string | undefined {
  return kind === null ? undefined : languageServerCompletionTypes.get(kind);
}

export function codeMirrorCompletion(item: LanguageServerCompletionItem): Completion {
  const type = completionType(item.kind);
  return {
    label: item.label,
    apply: item.insertText,
    ...(item.sortText === null ? {} : { sortText: item.sortText }),
    ...(item.detail === null ? {} : { detail: item.detail }),
    ...(item.documentation === null ? {} : { info: item.documentation }),
    ...(type ? { type } : {}),
    ...(item.commitCharacters.length === 0 ? {} : { commitCharacters: item.commitCharacters }),
    ...(item.deprecated ? { boost: -10 } : {}),
  };
}

export function definitionModifierPressed(
  event: Pick<MouseEvent | KeyboardEvent, 'ctrlKey' | 'metaKey'>,
): boolean {
  return workspace?.platform === 'darwin' ? event.metaKey : event.ctrlKey;
}

function hoverContentBlocks(contents: readonly string[]): string[] {
  return contents.flatMap((content) => {
    const trimmed = content.trim();
    if (!trimmed) return [];
    const fenced = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```(?:\r?\n([\s\S]+))?$/u.exec(trimmed);
    if (!fenced) return [trimmed];
    return [fenced[1]?.trim(), fenced[2]?.trim()]
      .filter((block): block is string => Boolean(block));
  });
}

export function languageServerHoverTooltip(
  view: EditorView,
  offset: number,
  response: LanguageServerHoverResult,
  compact: boolean,
): Tooltip | null {
  const blocks = hoverContentBlocks(response.contents);
  if (blocks.length === 0) return null;
  const visibleBlocks = compact ? blocks.slice(0, 1) : blocks;
  const fallbackRange = view.state.wordAt(offset);
  const requestedFrom = response.range ? editorOffsetAt(view, response.range.start) : fallbackRange?.from ?? offset;
  const requestedTo = response.range ? editorOffsetAt(view, response.range.end) : fallbackRange?.to ?? offset;
  const from = requestedFrom <= requestedTo ? requestedFrom : fallbackRange?.from ?? offset;
  const to = requestedFrom <= requestedTo ? requestedTo : fallbackRange?.to ?? offset;
  return {
    pos: from,
    end: to,
    above: true,
    arrow: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'workspace-editor-symbol-hover';
      dom.dataset.mode = compact ? 'preview' : 'documentation';
      for (const [index, block] of visibleBlocks.entries()) {
        const content = document.createElement(index === 0 ? 'pre' : 'p');
        content.className = index === 0
          ? 'workspace-editor-symbol-hover-signature'
          : 'workspace-editor-symbol-hover-documentation';
        content.textContent = block;
        dom.append(content);
      }
      return { dom };
    },
  };
}

export function languageServerSignatureTooltip(
  view: EditorView,
  response: LanguageServerSignatureHelpResult,
): Tooltip | null {
  const signatureIndex = response.activeSignature ?? 0;
  const signature = response.signatures[signatureIndex];
  if (!signature) return null;
  const activeParameterIndex = response.activeParameter ?? signature.activeParameter;
  const activeParameter = activeParameterIndex === null
    ? null
    : signature.parameters[activeParameterIndex] ?? null;
  return {
    pos: view.state.selection.main.head,
    above: false,
    arrow: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'workspace-editor-signature-help';
      const label = document.createElement('code');
      if (activeParameter) {
        const parameterIndex = signature.label.indexOf(activeParameter.label);
        if (parameterIndex >= 0) {
          label.append(signature.label.slice(0, parameterIndex));
          const active = document.createElement('strong');
          active.textContent = activeParameter.label;
          label.append(active, signature.label.slice(parameterIndex + activeParameter.label.length));
        } else {
          label.textContent = signature.label;
        }
      } else {
        label.textContent = signature.label;
      }
      dom.append(label);
      const documentation = activeParameter?.documentation ?? signature.documentation;
      if (documentation) {
        const detail = document.createElement('p');
        detail.textContent = documentation;
        dom.append(detail);
      }
      return { dom };
    },
  };
}

function positionComparison(left: LanguageServerPosition, right: LanguageServerPosition): number {
  return left.line - right.line || left.character - right.character;
}

export function rangeContainsPosition(
  range: LanguageServerRange,
  position: LanguageServerPosition,
): boolean {
  return positionComparison(range.start, position) <= 0
    && positionComparison(position, range.end) <= 0;
}

export function sameNavigationLocation(
  left: NavigationLocation | null,
  right: NavigationLocation | null,
): boolean {
  return Boolean(
    left
    && right
    && left.path === right.path
    && left.line === right.line
    && left.character === right.character,
  );
}
