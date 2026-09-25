import { WorkspaceLayoutControls, WorkspacePaneVisibilityContext } from '../shell/WorkspaceLayoutControls';
import {
  AlertTriangle,
  FileCode2,
  FileText,
} from 'lucide-react';
import { useContext, useEffect } from 'react';

import { FileTypeIcon } from '../../shared/file-icons/FileTypeIcon';
import {
  draggableWindowRegionStyle,
  FlatTab,
  FlatTabList,
  NeumorphicButton,
  nonDraggableWindowRegionStyle,
  TieredHeader,
} from '../../shared/ui';
import { WorkspaceEditorFileToolbar } from './WorkspaceEditorFileToolbar';
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
  const paneVisible = useContext(WorkspacePaneVisibilityContext);
  active = active && paneVisible;
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
    languageServerConfiguring,
    openReference,
    problemsRatio,
    problemsVisible,
    reloadSelectedFile,
    replaceAllMatches,
    replaceNextMatch,
    revealDiagnostic,
    selectAllMatches,
    selectedPath,
    selectReference,
    setProblemsRatio,
    submitRename,
    tabs,
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
                    leading={<FileTypeIcon className="workspace-editor-tab-icon" name={tabLabel(tab)} path={tab.path} />}
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
              <WorkspaceLayoutControls />
            </div>
          </>
        )}
        secondary={currentFile ? <WorkspaceEditorFileToolbar controller={controller} onOpenLocalHistory={onOpenLocalHistory}
          rightSidebarOpen={rightSidebarOpen} onToggleRightSidebar={onToggleRightSidebar} /> : undefined}
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
