import type { ReactNode, Ref } from 'react';

import { SidebarTabs } from '../../shared/ui';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import type { WorkspaceEntryMutation } from '../../cheshiDesktop';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { normalizeSidebarPanel, type SidebarPanel } from './sidebarPanel';

export type WorkspaceView = 'chats' | 'chat' | 'notes' | 'calendar' | 'blank' | 'codegraph' | 'editor' | 'git' | 'plugins' | 'terminal' | 'search' | 'local-history' | 'settings' | 'docker';

interface SidebarProps {
  chatPanel?: ReactNode;
  memoPanelRef?: Ref<HTMLDivElement>;
  chatsPanelRef?: Ref<HTMLDivElement>;
  activePanel?: SidebarPanel;
  onPanelChange?: (panel: SidebarPanel) => void;
  selectedFilePath: string | null;
  onWorkspaceEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenLocalHistory?: (path: string) => void;
}

export function Sidebar({
  chatPanel,
  memoPanelRef,
  chatsPanelRef,
  activePanel = 'files',
  onPanelChange,
  selectedFilePath,
  onWorkspaceEntryMutation,
  onOpenWorkspaceFile,
  onOpenLocalHistory,
}: SidebarProps) {
  const scrollbarSurface = useAutoHideScrollbars<HTMLElement>();
  const files = <WorkspaceFileTree selectedPath={selectedFilePath}
    onEntryMutation={onWorkspaceEntryMutation} onOpenFile={onOpenWorkspaceFile} onOpenLocalHistory={onOpenLocalHistory} />;
  return (
    <aside ref={scrollbarSurface} className="sidebar">
      <div className="sidebar-panel-content">
        <div className="sidebar-content-primary">
          {chatPanel && onPanelChange ? <SidebarTabs activeId={activePanel}
            onSelect={panel => onPanelChange(normalizeSidebarPanel(panel))}
            tabs={[
              { id: 'chats', label: 'SESSION', content: chatPanel },
              { id: 'files', label: 'EXPLORER', content: files },
              { id: 'agent-chats', label: 'WORKER', content: <div ref={chatsPanelRef} className="sidebar-content-primary" /> },
              { id: 'memos', label: 'MEMO', content: <div ref={memoPanelRef} className="sidebar-content-primary" /> },
              { id: 'github', label: 'GITHUB', content: null },
            ]} /> : files}
        </div>

      </div>
    </aside>
  );
}
