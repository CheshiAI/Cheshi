import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import { workspaceDiagnosticMarkClasses } from './workspaceDiagnostics';

export const workspaceEditorHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--editor-syntax-keyword)' },
  { tag: [tags.name, tags.variableName], color: 'var(--editor-syntax-name)' },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: 'var(--editor-syntax-property)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--editor-syntax-type)' },
  { tag: [tags.string, tags.character, tags.attributeValue, tags.regexp], color: 'var(--editor-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: 'var(--editor-syntax-number)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--editor-syntax-operator)' },
  { tag: [tags.comment, tags.meta], color: 'var(--editor-syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.heading, tags.strong], color: 'var(--editor-text)', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--editor-accent)', textDecoration: 'underline' },
  { tag: tags.inserted, color: 'var(--editor-syntax-type)' },
  { tag: [tags.deleted, tags.invalid], color: 'var(--editor-syntax-invalid)' },
]);

export const workspaceEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    background: 'transparent',
    color: 'var(--editor-text)',
    font: 'var(--editor-font-size)/var(--editor-line-height) var(--font-mono)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    background: 'transparent',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--editor-accent)',
    padding: '0 0 var(--space-4)',
  },
  '.cm-line': {
    padding: '0 var(--editor-line-padding)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--editor-accent)',
  },
  '.cm-gutters': {
    borderRight: '1px solid var(--editor-border)',
    background: 'var(--editor-gutter-surface)',
    color: 'var(--editor-muted)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 var(--space-10) 0 var(--space-12)',
  },
  '.cm-activeLine': {
    background: 'var(--editor-active-line)',
  },
  '.cm-activeLineGutter': {
    background: 'var(--editor-active-line-gutter)',
    color: 'var(--editor-accent)',
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    background: 'var(--editor-selection) !important',
  },
  '.cm-matchingBracket': {
    background: 'var(--editor-active-line-gutter)',
    color: 'var(--editor-accent)',
    outline: '1px solid var(--editor-border)',
  },
  [`.${workspaceDiagnosticMarkClasses.syntax}`]: {
    textDecorationColor: 'var(--editor-problem-syntax)',
  },
  [`.${workspaceDiagnosticMarkClasses.deprecated}`]: {
    textDecorationColor: 'var(--editor-problem-deprecated)',
  },
  [`.${workspaceDiagnosticMarkClasses['dead-code']}`]: {
    opacity: '.68',
    textDecorationColor: 'var(--editor-problem-dead-code)',
  },
  '.cm-panels:has(> [data-code-editor-search-bridge]:only-child)': {
    display: 'none',
  },
  '.cm-tooltip': {
    '--panel-backdrop-blur': '16px',
    border: '1px solid transparent',
    borderRadius: '12px',
    background: 'transparent',
    pointerEvents: 'auto',
  },
  '.cm-tooltip::before': {
    content: '""',
    position: 'absolute',
    inset: '-1px',
    zIndex: '-2',
    borderRadius: 'inherit',
    background: 'rgba(0, 0, 0, 0.01)',
    backdropFilter: 'blur(var(--panel-backdrop-blur)) saturate(var(--panel-backdrop-saturation))',
    WebkitBackdropFilter: 'blur(var(--panel-backdrop-blur)) saturate(var(--panel-backdrop-saturation))',
    pointerEvents: 'none',
  },
  '.cm-tooltip > .workspace-editor-tooltip-surface': {
    position: 'absolute',
    inset: '-1px',
    zIndex: '-1',
    borderRadius: 'inherit',
    background: 'rgba(0, 0, 0, 0.01)',
    pointerEvents: 'none',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    overflow: 'visible',
    color: 'var(--text)',
    padding: 'var(--space-6)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    width: 'min(520px, calc(100vw - 48px))',
    minWidth: 'min(360px, calc(100vw - 48px))',
    maxWidth: 'min(520px, calc(100vw - 48px))',
    height: 'auto',
    maxHeight: 'min(308px, 42vh)',
    margin: '0',
    overflowX: 'hidden',
    padding: '0',
    scrollbarColor: 'color-mix(in srgb, var(--editor-muted) 42%, transparent) transparent',
    scrollbarWidth: 'thin',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    minWidth: '0',
    minHeight: '28px',
    alignItems: 'center',
    borderRadius: '6px',
    color: 'var(--text)',
    fontSize: 'var(--font-size-label)',
    lineHeight: '16px',
    padding: 'var(--space-6) var(--space-10)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected="true"], .cm-tooltip.cm-tooltip-autocomplete > ul > li:hover': {
    background: 'var(--dropdown-selection-bg)',
    color: 'var(--active-text)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete::after': {
    display: 'block',
    borderTop: '1px solid var(--divider)',
    color: 'var(--sidebar-section-label-color)',
    content: '"↑↓ Navigate   ↵ Insert   Esc Close"',
    font: 'var(--font-size-caption)/16px var(--font-mono)',
    margin: 'var(--space-6) -6px -6px',
    padding: '5px var(--space-10) var(--space-6)',
  },
  '.cm-completionLabel': {
    minWidth: '0',
    overflow: 'hidden',
    flex: '0 1 auto',
    fontWeight: '500',
    textOverflow: 'ellipsis',
  },
  'li[aria-selected] > .cm-completionLabel': {
    fontWeight: '600',
  },
  '.cm-completionDetail': {
    minWidth: '0',
    maxWidth: '58%',
    overflow: 'hidden',
    flex: '1 1 auto',
    color: 'inherit',
    fontSize: 'var(--font-size-caption)',
    fontStyle: 'normal',
    marginLeft: 'auto',
    paddingLeft: 'var(--space-16)',
    textAlign: 'right',
    textOverflow: 'ellipsis',
  },
  '.cm-completionMatchedText': {
    color: 'inherit',
    fontWeight: '700',
    textDecoration: 'none',
  },
  '.cm-completionIcon': {
    display: 'inline-grid',
    width: '18px',
    height: '18px',
    flex: '0 0 18px',
    placeItems: 'center',
    boxSizing: 'border-box',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-small)',
    fontStyle: 'normal',
    fontWeight: '700',
    lineHeight: '18px',
    marginRight: 'var(--space-8)',
    opacity: '1',
    padding: '0',
  },
  '.cm-completionIcon-function::after, .cm-completionIcon-method::after': { content: '"ƒ"' },
  '.cm-completionIcon-constructor::after': { content: '"C"' },
  '.cm-completionIcon-property::after': { content: '"p"' },
  '.cm-completionIcon-variable::after': { content: '"x"' },
  '.cm-completionIcon-class::after': { content: '"C"' },
  '.cm-completionIcon-interface::after': { content: '"I"' },
  '.cm-completionIcon-namespace::after': { content: '"N"' },
  '.cm-completionIcon-unit::after': { content: '"u"' },
  '.cm-completionIcon-value::after': { content: '"v"' },
  '.cm-completionIcon-enum::after': { content: '"E"' },
  '.cm-completionIcon-enum-member::after': { content: '"e"' },
  '.cm-completionIcon-keyword::after': { content: '"k"' },
  '.cm-completionIcon-snippet::after': { content: '"s"' },
  '.cm-completionIcon-color::after': { content: '"●"' },
  '.cm-completionIcon-file::after': { content: '"▤"' },
  '.cm-completionIcon-reference::after': { content: '"↗"' },
  '.cm-completionIcon-folder::after': { content: '"▰"' },
  '.cm-completionIcon-constant::after': { content: '"V"' },
  '.cm-completionIcon-struct::after': { content: '"S"' },
  '.cm-completionIcon-event::after': { content: '"e"' },
  '.cm-completionIcon-operator::after': { content: '"±"' },
  '.cm-completionIcon-type-parameter::after': { content: '"T"' },
  '.cm-completionIcon-text::after': {
    content: '"abc"',
    fontSize: '7px',
  },
  '.cm-completionIcon-function, .cm-completionIcon-method, .cm-completionIcon-snippet, .cm-completionIcon-event': {
    color: 'var(--editor-completion-function-color)',
  },
  '.cm-completionIcon-variable, .cm-completionIcon-property, .cm-completionIcon-interface, .cm-completionIcon-type-parameter': {
    color: 'var(--editor-completion-property-color)',
  },
  '.cm-completionIcon-constructor, .cm-completionIcon-class, .cm-completionIcon-struct': {
    color: 'var(--editor-completion-class-color)',
  },
  '.cm-completionIcon-constant, .cm-completionIcon-value, .cm-completionIcon-enum, .cm-completionIcon-enum-member, .cm-completionIcon-unit': {
    color: 'var(--editor-completion-value-color)',
  },
  '.cm-completionIcon-keyword, .cm-completionIcon-operator': {
    color: 'var(--editor-completion-keyword-color)',
  },
  '.cm-completionIcon-namespace, .cm-completionIcon-file, .cm-completionIcon-folder, .cm-completionIcon-reference, .cm-completionIcon-text': {
    color: 'var(--editor-completion-file-color)',
  },
  '.cm-completionIcon-color': {
    color: 'var(--editor-accent)',
  },
  '.cm-tooltip.cm-completionInfo': {
    color: 'var(--editor-text)',
    font: 'var(--font-size-small)/1.55 var(--font-mono)',
    padding: 'var(--space-10) var(--space-12)',
  },
  '.cm-tooltip.cm-tooltip-hover': {
    maxWidth: 'min(720px, calc(100vw - 48px))',
    overflow: 'visible',
    color: 'var(--editor-text)',
  },
  '.cm-tooltip.cm-tooltip-lint': {
    color: 'var(--editor-text)',
  },
  '.cm-tooltip-lint .cm-diagnostic': {
    paddingLeft: '12px',
    paddingRight: '12px',
    marginLeft: '0',
  },
  '.cm-tooltip-lint .cm-diagnostic-error': {
    borderLeft: '0',
  },
  '.cm-tooltip-hover .cm-tooltip-section': {
    border: '0',
  },
  '.workspace-editor-symbol-hover': {
    maxWidth: 'min(720px, calc(100vw - 48px))',
    boxSizing: 'border-box',
    padding: '6px 10px',
  },
  '.workspace-editor-symbol-hover[data-mode="documentation"]': {
    maxHeight: 'min(520px, calc(100vh - 96px))',
    overflow: 'auto',
    scrollbarColor: 'color-mix(in srgb, var(--editor-muted) 42%, transparent) transparent',
    scrollbarWidth: 'thin',
  },
  '.workspace-editor-symbol-hover-signature, .workspace-editor-symbol-hover-documentation': {
    margin: '0',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  '.cm-tooltip.workspace-editor-signature-help': {
    minWidth: '260px',
    maxWidth: 'min(680px, calc(100vw - 48px))',
    color: 'var(--editor-text)',
    padding: 'var(--space-10) var(--space-12)',
  },
  '.workspace-editor-signature-help code': {
    display: 'block',
    overflowWrap: 'anywhere',
    font: '500 var(--font-size-label)/1.55 var(--font-mono)',
    whiteSpace: 'pre-wrap',
  },
  '.workspace-editor-signature-help code strong': {
    borderRadius: 'var(--radius-small)',
    background: 'var(--dropdown-selection-bg)',
    color: 'var(--dropdown-selection-text)',
    fontWeight: '700',
    padding: '1px var(--space-2)',
  },
  '.workspace-editor-signature-help p': {
    borderTop: '1px solid var(--editor-border)',
    color: 'var(--editor-muted)',
    fontSize: 'var(--font-size-small)',
    lineHeight: '1.5',
    margin: 'var(--space-8) 0 0',
    paddingTop: 'var(--space-8)',
  },
  '.workspace-editor-symbol-hover-signature': {
    color: 'var(--editor-text)',
    font: '500 var(--font-size-default)/18px var(--font-mono)',
  },
  '.workspace-editor-symbol-hover-documentation': {
    borderTop: '1px solid color-mix(in srgb, var(--editor-completion-border) 70%, transparent)',
    color: 'var(--editor-completion-detail)',
    fontSize: 'var(--font-size-label)',
    lineHeight: '17px',
    marginTop: 'var(--space-10)',
    paddingTop: 'var(--space-10)',
  },
  '.workspace-editor-definition-link': {
    cursor: 'pointer',
    textDecorationColor: 'var(--editor-accent)',
    textDecorationLine: 'underline',
    textDecorationStyle: 'solid',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
  },
  '.cm-tooltip-above > .cm-tooltip-arrow::before': {
    borderTopColor: 'var(--divider)',
  },
  '.cm-tooltip-above > .cm-tooltip-arrow::after': {
    borderTopColor: 'rgba(0, 0, 0, 0.01)',
  },
  '.cm-tooltip-below > .cm-tooltip-arrow::before': {
    borderBottomColor: 'var(--divider)',
  },
  '.cm-tooltip-below > .cm-tooltip-arrow::after': {
    borderBottomColor: 'rgba(0, 0, 0, 0.01)',
  },
});
