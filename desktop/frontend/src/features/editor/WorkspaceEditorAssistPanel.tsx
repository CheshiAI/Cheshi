import {
  ArrowRight,
  Check,
  FileSearch,
  Lightbulb,
  LoaderCircle,
  PencilLine,
  X,
} from 'lucide-react';
import { useRef, type SubmitEvent } from 'react';

import { LiquidGlassPanel, LoadingState, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import type {
  LanguageServerCodeAction,
  LanguageServerLocation,
} from '../../cheshiDesktop';
import type { WorkspaceEditorAssistState } from './workspaceEditorAssistState';

export type { ReferenceSourcePreview, WorkspaceEditFilePreview, WorkspaceEditorAssistState } from './workspaceEditorAssistState';

const MAX_RENDERED_EDIT_PREVIEWS = 40;

interface WorkspaceEditorAssistPanelProps {
  state: WorkspaceEditorAssistState;
  onApplyEdit: () => void;
  onChooseAction: (action: LanguageServerCodeAction) => void;
  onClose: () => void;
  onOpenReference: (location: LanguageServerLocation) => void;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onSelectReference: (index: number) => void;
}

function assistTitle(state: WorkspaceEditorAssistState): string {
  if (state.kind === 'references') return `${state.locations.length} reference${state.locations.length === 1 ? '' : 's'}`;
  if (state.kind === 'actions') return 'Quick fixes and refactorings';
  if (state.kind === 'rename') return 'Rename symbol';
  return state.title;
}

function AssistIcon({ state }: { state: WorkspaceEditorAssistState }) {
  if (state.kind === 'references') return <FileSearch aria-hidden="true" />;
  if (state.kind === 'actions') return <Lightbulb aria-hidden="true" />;
  if (state.kind === 'rename') return <PencilLine aria-hidden="true" />;
  return <Check aria-hidden="true" />;
}

export function WorkspaceEditorAssistPanel({
  state,
  onApplyEdit,
  onChooseAction,
  onClose,
  onOpenReference,
  onRenameChange,
  onRenameSubmit,
  onSelectReference,
}: WorkspaceEditorAssistPanelProps) {
  const renameInputRef = useRef<HTMLInputElement>(null);
  const sharedPopup = state.kind === 'references' || state.kind === 'actions' || state.kind === 'rename';
  const selectedReference = state.kind === 'references'
    ? state.locations[state.selectedIndex]
    : undefined;
  const submitRename = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!state || state.kind !== 'rename' || !state.value || state.submitting) return;
    onRenameSubmit();
  };

  const panel = (
    <LiquidGlassPanel
      as="section"
      aria-label={assistTitle(state)}
      className="workspace-editor-assist"
      data-kind={state.kind}
      data-liquid-glass-backdrop="true"
      role="dialog"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="workspace-editor-assist-header">
        <AssistIcon state={state} />
        <strong>{assistTitle(state)}</strong>
        <NeumorphicButton
          raised={!sharedPopup}
          variant={sharedPopup ? 'standard' : undefined}
          size={sharedPopup ? 'icon' : undefined}
          aria-label="Close editor assistant"
          title="Close editor assistant"
          className={sharedPopup ? undefined : 'workspace-editor-assist-close'}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </NeumorphicButton>
      </header>

      {state.kind === 'references' && (
        <div className="workspace-editor-reference-layout">
          <ol className="workspace-editor-reference-list">
            {state.locations.map((location, index) => (
              <li key={`${location.path}:${location.range.start.line}:${location.range.start.character}`}>
                <button
                  data-active={index === state.selectedIndex ? 'true' : undefined}
                  type="button"
                  onClick={() => onSelectReference(index)}
                  onDoubleClick={() => onOpenReference(location)}
                >
                  <span>{location.path}</span>
                  <small>{location.range.start.line + 1}:{location.range.start.character + 1}</small>
                </button>
              </li>
            ))}
          </ol>
          <div className="workspace-editor-reference-preview"
            data-empty={!state.previewLoading && !state.preview ? 'true' : undefined}>
            {state.previewLoading ? (
              <LoaderCircle className="workspace-editor-spinner" aria-label="Loading reference preview" />
            ) : state.preview ? (
              <pre>
                {state.preview.content.split('\n').map((line, index) => {
                  const lineNumber = state.preview!.startLine + index;
                  return (
                    <span
                      data-target={lineNumber === state.preview!.targetLine ? 'true' : undefined}
                      key={lineNumber}
                    >
                      <i>{lineNumber}</i>
                      <code>{line || ' '}</code>
                    </span>
                  );
                })}
              </pre>
            ) : (
              <span className="workspace-editor-reference-empty">Source preview is unavailable.</span>
            )}
          </div>
          {selectedReference && (
            <NeumorphicButton
              raised
              className="workspace-editor-assist-primary"
              type="button"
              onClick={() => onOpenReference(selectedReference)}
            >
              Open reference
              <ArrowRight aria-hidden="true" />
            </NeumorphicButton>
          )}
        </div>
      )}

      {state.kind === 'actions' && (
        <ul className="workspace-editor-action-list" aria-busy={state.loading}>
          {state.loading ? (
            <li className="workspace-editor-assist-empty">
              <LoadingState type="processing" />
            </li>
          ) : state.error ? (
            <li className="workspace-editor-assist-empty" role="alert">{state.error}</li>
          ) : state.actions.length > 0 ? state.actions.map((action, index) => (
            <li key={`${action.title}:${index}`}>
              <button
                disabled={Boolean(action.disabledReason) || !action.edit}
                title={action.disabledReason ?? action.kind ?? action.title}
                type="button"
                onClick={() => onChooseAction(action)}
              >
                <Lightbulb aria-hidden="true" />
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.disabledReason ?? action.kind ?? 'code action'}</small>
                </span>
                {action.preferred && <em>Preferred</em>}
              </button>
            </li>
          )) : (
            <li className="workspace-editor-assist-empty">No code actions are available here.</li>
          )}
        </ul>
      )}

      {state.kind === 'rename' && (
        <form className="workspace-editor-rename" onSubmit={submitRename}>
          <label htmlFor="workspace-editor-rename-input">New symbol name</label>
          <NeumorphicTextField
            variant="standard"
            autoFocus
            ref={renameInputRef}
            id="workspace-editor-rename-input"
            maxLength={256}
            value={state.value}
            placeholder={state.placeholder}
            onChange={(event) => onRenameChange(event.target.value)}
            trailingAction={state.value ? (
              <SearchClearButton
                variant="ghost"
                aria-label="Clear symbol name"
                onClick={() => {
                  onRenameChange('');
                  requestAnimationFrame(() => renameInputRef.current?.focus());
                }}
              />
            ) : undefined}
          />
          <NeumorphicButton
            variant="standard"
            disabled={!state.value || state.submitting}
            type="submit"
          >
            {state.submitting ? <LoaderCircle className="workspace-editor-spinner" aria-hidden="true" /> : <PencilLine aria-hidden="true" />}
            Preview rename
          </NeumorphicButton>
        </form>
      )}

      {state.kind === 'edit-preview' && (
        <div className="workspace-editor-edit-preview">
          <p>{state.files.length} file{state.files.length === 1 ? '' : 's'} will be updated and saved.</p>
          <ul>
            {state.files.map((file) => (
              <li key={file.path}>
                <strong>{file.path}</strong>
                {file.edits.slice(0, MAX_RENDERED_EDIT_PREVIEWS).map((edit, index) => (
                  <pre key={`${edit.line}:${index}`}>
                    <span className="workspace-editor-edit-line">Line {edit.line}</span>
                    <del>− {edit.before || '(empty)'}</del>
                    <ins>+ {edit.after || '(empty)'}</ins>
                  </pre>
                ))}
                {file.edits.length > MAX_RENDERED_EDIT_PREVIEWS && (
                  <span className="workspace-editor-edit-preview-more">
                    {file.edits.length - MAX_RENDERED_EDIT_PREVIEWS} additional edits are not shown.
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="workspace-editor-assist-footer">
            <button type="button" onClick={onClose}>Cancel</button>
            <NeumorphicButton
              raised
              className="workspace-editor-assist-primary"
              disabled={state.applying}
              type="button"
              onClick={onApplyEdit}
            >
              {state.applying ? <LoaderCircle className="workspace-editor-spinner" aria-hidden="true" /> : <Check aria-hidden="true" />}
              Apply and save
            </NeumorphicButton>
          </div>
        </div>
      )}
    </LiquidGlassPanel>
  );
  return sharedPopup
    ? <div className="workspace-editor-assist-popup-anchor">{panel}</div>
    : panel;
}
