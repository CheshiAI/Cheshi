import { useContext } from 'react';
import { SidebarToggleVisibility } from '../../shared/ui/SidebarToggle';
import { AlertTriangle, ArrowLeft, ArrowRight, BookOpen, FileSearch, History, Lightbulb, PanelRight, PencilLine, RotateCw, Save, Search } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui/NeumorphicButton';
import { ToolbarMenu, type ToolbarMenuItem } from '../../shared/ui/ToolbarMenu';
import { nonDraggableWindowRegionStyle } from '../../shared/ui/electronStyles';
import { canUseLanguageServer, formatBytes } from './workspaceEditorModel';
import type { useWorkspaceEditorController } from './useWorkspaceEditorController';

type ToolbarController = Pick<ReturnType<typeof useWorkspaceEditorController>,
  'activeLanguageServer' | 'activeTab' | 'conflictMessage' | 'currentFile' | 'editorSearchOpen' |
  'isDirty' | 'languageServers' | 'navigateHistory' | 'navigationAvailability' | 'problemsVisible' |
  'requestCodeActionsAtSelection' | 'requestReferencesAtSelection' | 'requestRenameAtSelection' |
  'saveFile' | 'saving' | 'setProblemsOpen' | 'toggleEditorSearch'> & {
    codeExplanation: Pick<ReturnType<typeof useWorkspaceEditorController>['codeExplanation'], 'explainCurrentSelection'>;
  };

export function WorkspaceEditorFileToolbar({ controller, onOpenLocalHistory, rightSidebarOpen = false, onToggleRightSidebar }: {
  controller: ToolbarController;
  onOpenLocalHistory?: (path: string) => void;
  rightSidebarOpen?: boolean;
  onToggleRightSidebar?: () => void;
}) {
  const sidebarToggleVisible = useContext(SidebarToggleVisibility);
  const { currentFile, activeTab, conflictMessage, isDirty, saving, activeLanguageServer, languageServers } = controller;
  if (!currentFile) return null;
  const textFile = currentFile.fileKind === 'text';
  const hasLanguageServer = activeLanguageServer && canUseLanguageServer(activeLanguageServer.language, languageServers);
  const items: ToolbarMenuItem[] = [
    { id: 'back', label: 'Navigate back', icon: <ArrowLeft aria-hidden="true" />, disabled: !controller.navigationAvailability.back,
      shortcut: '⌘[ / Ctrl+-', onSelect: () => { void controller.navigateHistory('back'); } },
    { id: 'forward', label: 'Navigate forward', icon: <ArrowRight aria-hidden="true" />, disabled: !controller.navigationAvailability.forward,
      shortcut: '⌘] / Ctrl+Shift+-', onSelect: () => { void controller.navigateHistory('forward'); } },
  ];
  if (textFile) items.push(
    { id: 'history', label: 'Local history', icon: <History aria-hidden="true" />, separatorBefore: true,
      disabled: !onOpenLocalHistory || Boolean(activeTab?.sourceExcerpt), onSelect: () => onOpenLocalHistory?.(currentFile.path) },
    { id: 'explain', label: 'Explain selected code', icon: <BookOpen aria-hidden="true" />,
      onSelect: controller.codeExplanation.explainCurrentSelection },
  );
  if (textFile && hasLanguageServer) items.push(
    { id: 'references', label: 'Find symbol references', icon: <FileSearch aria-hidden="true" />, shortcut: 'Shift+F12', separatorBefore: true,
      onSelect: controller.requestReferencesAtSelection },
    { id: 'fixes', label: 'Show quick fixes', icon: <Lightbulb aria-hidden="true" />, shortcut: '⌘. / Ctrl+.',
      onSelect: controller.requestCodeActionsAtSelection },
    { id: 'rename', label: 'Rename symbol', icon: <PencilLine aria-hidden="true" />, shortcut: 'F2',
      onSelect: controller.requestRenameAtSelection },
  );
  if (onToggleRightSidebar && sidebarToggleVisible) items.push({
    id: 'sidebar', label: rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar',
    icon: <PanelRight aria-hidden="true" />, separatorBefore: true, onSelect: onToggleRightSidebar,
  });
  return <>
    <div className="workspace-editor-file-info">
      <strong title={`${currentFile.path}\n${currentFile.lineEnding.toUpperCase()} · ${formatBytes(currentFile.size)} · rev ${currentFile.revision}`}>
        {currentFile.path.split('/').at(-1) ?? currentFile.path}
      </strong>
      <div className="workspace-editor-file-meta">
        {activeTab?.sourceExcerpt ? <span className="workspace-editor-readonly-label">Read only</span>
          : conflictMessage ? <span className="workspace-editor-conflict-label">Conflict</span>
            : isDirty ? <span className="workspace-editor-unsaved-label">Modified</span> : null}
      </div>
    </div>
    <div className="workspace-editor-actions" style={nonDraggableWindowRegionStyle}>
      {textFile && <>
        <NeumorphicButton size="icon" active={controller.editorSearchOpen}
          aria-controls="workspace-editor-search" aria-expanded={controller.editorSearchOpen}
          aria-label="Find and replace" title="Find and replace (⌘F / Ctrl+F)" onClick={controller.toggleEditorSearch}>
          <Search aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton size="icon" aria-controls="workspace-editor-problems" aria-expanded={controller.problemsVisible}
          aria-label={controller.problemsVisible ? 'Close problems panel' : 'Open problems panel'} title="Problems"
          onClick={() => controller.setProblemsOpen(open => !open)}>
          <AlertTriangle aria-hidden="true" />
        </NeumorphicButton>
        {(isDirty || saving) && <NeumorphicButton size="icon" aria-label="Save file" title="Save (⌘S / Ctrl+S)"
          disabled={!isDirty || saving || Boolean(conflictMessage)} onClick={() => { void controller.saveFile(); }}>
          {saving ? <RotateCw className="workspace-editor-spinner" aria-hidden="true" /> : <Save aria-hidden="true" />}
        </NeumorphicButton>}
      </>}
      <ToolbarMenu label="File actions" items={items} />
    </div>
  </>;
}
