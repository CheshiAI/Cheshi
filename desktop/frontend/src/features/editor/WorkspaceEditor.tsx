import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  FileCode2,
  FileSearch,
  FileText,
  History,
  Lightbulb,
  PanelBottom,
  PanelRight,
  PencilLine,
  RotateCw,
  Save,
  Search,
} from 'lucide-react';
import { useEffect } from 'react';

import {
  draggableWindowRegionStyle,
  FlatTab,
  FlatTabList,
  NeumorphicButton,
  nonDraggableWindowRegionStyle,
  TieredHeader,
} from '../../shared/ui';
import { WorkspaceCodeExplanationMenu } from './WorkspaceCodeExplanationMenu';
import type { GitLineBlameRequest } from '../../../../shared/git-line-blame';
import { WorkspaceCodeExplanationToast } from './WorkspaceCodeExplanationToast';
import { WorkspaceEditorAssistPanel } from './WorkspaceEditorAssistPanel';
import { WorkspaceEditorSearchPanel } from './WorkspaceEditorSearchPanel';
import { WorkspaceProblemsPanel } from './WorkspaceProblemsPanel';
import { useWorkspaceProblemsLayout } from './workspaceProblemsLayout';
import {
  WorkspaceProblemsResizer,
  workspaceProblemsStageStyle,
} from './WorkspaceProblemsResizer';
import {
  canUseLanguageServer,
  formatBytes,
  isTabDirty,
  tabLabel,
} from './workspaceEditorModel';
import {
  useWorkspaceEditorController,
  type WorkspaceEditorMutation,
  type WorkspaceEditorTarget,
} from './useWorkspaceEditorController';
import './workspace-editor.css';

export type { WorkspaceEditorMutation, WorkspaceEditorTarget } from './useWorkspaceEditorController';

interface WorkspaceEditorProps {
  sessionMode?: import('../../../../shared/editor-session').EditorSessionMode;
  onSessionRestored?: () => void;
  active: boolean;
  rightSidebarOpen?: boolean;
  onToggleRightSidebar?: () => void;
  mutation: WorkspaceEditorMutation | null;
  target: WorkspaceEditorTarget | null;
  onAllTabsClosed: () => void;
  onSelectedPathChange: (path: string | null) => void;
  onDirtyPathsChange?: (paths: string[]) => void;
  onOpenLocalHistory?: (path: string) => void;
  onShowLineCommit: (request: GitLineBlameRequest) => void;
}

export function WorkspaceEditor({
  sessionMode,
  onSessionRestored,
  active,
  rightSidebarOpen = false,
  onToggleRightSidebar,
  mutation,
  target,
  onAllTabsClosed,
  onSelectedPathChange,
  onDirtyPathsChange,
  onOpenLocalHistory,
  onShowLineCommit,
}: WorkspaceEditorProps) {
  const controller = useWorkspaceEditorController({
    sessionMode,
    onSessionRestored,
    active,
    mutation,
    target,
    onAllTabsClosed,
    onSelectedPathChange,
  });
  const {
    activeLanguageServer,
    activeTab,
    activateOpenTab,
    applyPreparedWorkspaceEdit,
    assistState,
    changeRenameValue,
    chooseCodeAction,
    closeAllTabs,
    closeAssist,
    closeEditorSearch,
    closeTab,
    configureActiveLanguageServer,
    codeExplanation,
    conflictMessage,
    copyTabFullPath,
    currentFile,
    diagnostics,
    diagnosticsStatus,
    editorHostRef,
    editorSearchControls,
    editorSearchInputRef,
    editorSearchOpen,
    editorSearchQueryValid,
    errorMessage,
    findNextMatch,
    findPreviousMatch,
    isDirty,
    languageServerConfiguring,
    languageServers,
    navigateHistory,
    navigationAvailability,
    openReference,
    problemsRatio,
    problemsVisible,
    reloadSelectedFile,
    replaceAllMatches,
    replaceNextMatch,
    requestCodeActionsAtSelection,
    requestReferencesAtSelection,
    requestRenameAtSelection,
    revealDiagnostic,
    saveFile,
    saving,
    selectAllMatches,
    selectedPath,
    selectReference,
    setProblemsOpen,
    setProblemsRatio,
    submitRename,
    tabs,
    toggleEditorSearch,
    updateEditorSearchControls,
  } = controller;
  const problemsLayout = useWorkspaceProblemsLayout(problemsRatio, active);
  const dirtyPathKey = tabs.filter(isTabDirty).map(tab => tab.path).join('\0');
  useEffect(() => {
    onDirtyPathsChange?.(dirtyPathKey ? dirtyPathKey.split('\0') : []);
  }, [dirtyPathKey, onDirtyPathsChange]);

  const explanationToast = (
    <WorkspaceCodeExplanationToast
      state={codeExplanation.state}
      selectionError={codeExplanation.selectionError}
      onDismiss={codeExplanation.dismiss}
    />
  );

  if (!active) return explanationToast;

  return (
    <main className="workspace-editor" aria-label="Workspace editor">
      <TieredHeader
        className="workspace-editor-header"
        primaryClassName="workspace-editor-tab-row"
        primary={(
          <>
            <FlatTabList aria-label="Open files" onCloseAll={closeAllTabs}>
              {tabs.map((tab) => {
                const selected = tab.path === selectedPath;
                return (
                  <FlatTab
                    active={selected}
                    closeLabel={`Close ${tab.path}`}
                    key={tab.path}
                    label={tabLabel(tab)}
                    leading={<FileText aria-hidden="true" />}
                    onActivate={() => activateOpenTab(tab.path)}
                    onClose={() => closeTab(tab.path)}
                    onCopyFullPath={() => void copyTabFullPath(tab.path)}
                    onOpenLocalHistory={onOpenLocalHistory && !tab.sourceExcerpt && tab.file.fileKind === 'text'
                      ? () => onOpenLocalHistory(tab.path) : undefined}
                    style={nonDraggableWindowRegionStyle}
                    title={tab.path}
                    trailing={isTabDirty(tab) && (
                      <span className="workspace-editor-tab-modified" aria-label="Unsaved changes" />
                    )}
                  />
                );
              })}
            </FlatTabList>
            <div
              className="workspace-editor-header-actions"
              style={nonDraggableWindowRegionStyle}
            >
              <NeumorphicButton
                raised
                aria-label="Navigate back"
                className="neumorphic-surface workspace-editor-action"
                disabled={!navigationAvailability.back}
                title="Navigate back (⌘[ / Ctrl+-)"
                type="button"
                onClick={() => void navigateHistory('back')}
              >
                <ArrowLeft aria-hidden="true" />
              </NeumorphicButton>
              <NeumorphicButton
                raised
                aria-label="Navigate forward"
                className="neumorphic-surface workspace-editor-action"
                disabled={!navigationAvailability.forward}
                title="Navigate forward (⌘] / Ctrl+Shift+-)"
                type="button"
                onClick={() => void navigateHistory('forward')}
              >
                <ArrowRight aria-hidden="true" />
              </NeumorphicButton>
              <NeumorphicButton
                raised
                type="button"
                aria-controls="workspace-editor-problems"
                aria-expanded={problemsVisible}
                aria-label={problemsVisible ? 'Close problems panel' : 'Open problems panel'}
                className="neumorphic-surface codegraph-inspector-toggle"
                disabled={currentFile?.fileKind !== 'text'}
                style={nonDraggableWindowRegionStyle}
                onClick={() => setProblemsOpen((open) => !open)}
              >
                <PanelBottom aria-hidden="true" />
              </NeumorphicButton>
              {onToggleRightSidebar && <NeumorphicButton raised size="icon"
                aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
                title={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
                aria-pressed={rightSidebarOpen} aria-expanded={rightSidebarOpen}
                onClick={onToggleRightSidebar}>
                <PanelRight aria-hidden="true" />
              </NeumorphicButton>}
            </div>
          </>
        )}
        secondary={currentFile ? (
          <>
            <div className="workspace-editor-file-info">
              <strong>{currentFile.path.split('/').at(-1) ?? currentFile.path}</strong>
              <div className="workspace-editor-file-meta">
                <span className="workspace-editor-file-revision">
                  {currentFile.lineEnding.toUpperCase()} · {formatBytes(currentFile.size)} · rev {currentFile.revision.slice(-12)}
                </span>
                {activeTab?.sourceExcerpt
                  ? <span className="workspace-editor-readonly-label">Read only</span>
                  : conflictMessage
                    ? <span className="workspace-editor-conflict-label">Conflict</span>
                    : isDirty
                      ? <span className="workspace-editor-unsaved-label">Modified</span>
                      : null}
              </div>
            </div>
            <div className="workspace-editor-actions" style={nonDraggableWindowRegionStyle}>
              {currentFile.fileKind === 'text' && (
                <>
                  <NeumorphicButton raised size="icon" aria-label="Local history" title="Local history"
                    disabled={!onOpenLocalHistory || Boolean(activeTab?.sourceExcerpt)}
                    onClick={() => onOpenLocalHistory?.(currentFile.path)}>
                    <History aria-hidden="true" />
                  </NeumorphicButton>
                  <NeumorphicButton
                    raised
                    active={editorSearchOpen}
                    className="neumorphic-surface workspace-editor-action"
                    aria-controls="workspace-editor-search"
                    aria-expanded={editorSearchOpen}
                    aria-label="Find and replace"
                    title="Find and replace (⌘F / Ctrl+F)"
                    onClick={toggleEditorSearch}
                  >
                    <Search aria-hidden="true" />
                  </NeumorphicButton>
                  <NeumorphicButton
                    raised
                    className="neumorphic-surface workspace-editor-action"
                    aria-label="Save file"
                    title="Save (⌘S / Ctrl+S)"
                    disabled={!isDirty || saving || Boolean(conflictMessage)}
                    onClick={() => void saveFile()}
                  >
                    {saving
                      ? <RotateCw className="workspace-editor-spinner" aria-hidden="true" />
                      : <Save aria-hidden="true" />}
                  </NeumorphicButton>
                  {activeLanguageServer && canUseLanguageServer(activeLanguageServer.language, languageServers) && (
                    <>
                      <NeumorphicButton
                        raised
                        className="neumorphic-surface workspace-editor-action"
                        aria-label="Find symbol references"
                        title="Find references (Shift+F12)"
                        onClick={requestReferencesAtSelection}
                      >
                        <FileSearch aria-hidden="true" />
                      </NeumorphicButton>
                      <NeumorphicButton
                        raised
                        className="neumorphic-surface workspace-editor-action"
                        aria-label="Show quick fixes"
                        title="Quick fix (⌘. / Ctrl+.)"
                        onClick={requestCodeActionsAtSelection}
                      >
                        <Lightbulb aria-hidden="true" />
                      </NeumorphicButton>
                      <NeumorphicButton
                        raised
                        className="neumorphic-surface workspace-editor-action"
                        aria-label="Rename symbol"
                        title="Rename symbol (F2)"
                        onClick={requestRenameAtSelection}
                      >
                        <PencilLine aria-hidden="true" />
                      </NeumorphicButton>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        ) : undefined}
        tertiary={editorSearchOpen && currentFile?.fileKind === 'text' ? (
          <WorkspaceEditorSearchPanel
            controls={editorSearchControls}
            inputRef={editorSearchInputRef}
            queryValid={editorSearchQueryValid}
            onChange={updateEditorSearchControls}
            onNext={findNextMatch}
            onPrevious={findPreviousMatch}
            onSelectAll={selectAllMatches}
            onReplace={replaceNextMatch}
            onReplaceAll={replaceAllMatches}
            onClose={closeEditorSearch}
          />
        ) : undefined}
        style={draggableWindowRegionStyle}
      />

      {errorMessage && (
        <div className="workspace-editor-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      {conflictMessage && (
        <div className="workspace-editor-conflict" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{conflictMessage}</span>
          <NeumorphicButton
            className="neumorphic-surface workspace-editor-conflict-reload"
            onClick={reloadSelectedFile}
          >
            Reload from disk
          </NeumorphicButton>
        </div>
      )}

      <section
        ref={problemsLayout.stageRef}
        className="workspace-editor-stage"
        data-problems-open={currentFile?.fileKind === 'text' ? String(problemsVisible) : undefined}
        aria-label={currentFile ? `Editor for ${currentFile.path}` : 'Editor canvas'}
        style={currentFile?.fileKind === 'text' ? workspaceProblemsStageStyle(problemsLayout.ratio, problemsVisible) : undefined}
      >
        {currentFile?.fileKind === 'text' ? (
          <>
            <div ref={editorHostRef} className="workspace-editor-host" {...codeExplanation.hostHandlers} />
            <WorkspaceProblemsResizer
              ratio={problemsLayout.ratio}
              onRatioChange={setProblemsRatio}
            />
            <WorkspaceProblemsPanel
              open={problemsVisible}
              content={activeTab?.draftContent ?? ''}
              diagnostics={diagnostics}
              filePath={currentFile.path}
              languageServer={activeLanguageServer}
              languageServerConfiguring={languageServerConfiguring}
              status={diagnosticsStatus}
              onConfigureLanguageServer={(mode) => void configureActiveLanguageServer(mode)}
              onSelectDiagnostic={revealDiagnostic}
            />
          </>
        ) : activeTab?.sourceExcerpt ? (
          <div className="workspace-editor-source-excerpt">
            <div className="workspace-editor-source-excerpt-notice" role="note">
              <FileText aria-hidden="true" />
              <span>
                Read-only definition excerpt · lines {activeTab.sourceExcerpt.startLine}–{activeTab.sourceExcerpt.endLine}
              </span>
            </div>
            <div ref={editorHostRef} className="workspace-editor-host" {...codeExplanation.hostHandlers} />
          </div>
        ) : currentFile?.fileKind === 'image' ? (
          <div className="workspace-editor-preview">
            {activeTab?.previewDataUrl
              ? <img src={activeTab.previewDataUrl} alt={currentFile.path} />
              : <p>Image preview is unavailable for files larger than the preview limit.</p>}
          </div>
        ) : currentFile ? (
          <div className="workspace-editor-empty">
            <span className="workspace-editor-empty-mark">
              <AlertTriangle aria-hidden="true" />
            </span>
            <strong>{currentFile.fileKind === 'too_large' ? 'File is too large to edit' : 'Binary file'}</strong>
            <p>{currentFile.path} · {formatBytes(currentFile.size)}</p>
          </div>
        ) : (
          <div className="workspace-editor-empty">
            <span className="workspace-editor-empty-mark">
              <FileCode2 aria-hidden="true" />
            </span>
            <strong>Choose a file</strong>
            <p>Open a file from the Explorer to inspect or edit it.</p>
          </div>
        )}
        {assistState && (
          <WorkspaceEditorAssistPanel
            state={assistState}
            onApplyEdit={() => void applyPreparedWorkspaceEdit()}
            onChooseAction={chooseCodeAction}
            onClose={closeAssist}
            onOpenReference={openReference}
            onRenameChange={changeRenameValue}
            onRenameSubmit={() => void submitRename()}
            onSelectReference={selectReference}
          />
        )}
      </section>
      {codeExplanation.menu && (
        <WorkspaceCodeExplanationMenu
          target={codeExplanation.menu}
          onClose={codeExplanation.closeMenu}
          onExplain={codeExplanation.explainSelection}
          onShowLineCommit={() => codeExplanation.showLineCommit(onShowLineCommit)}
        />
      )}
      {explanationToast}
    </main>
  );
}
