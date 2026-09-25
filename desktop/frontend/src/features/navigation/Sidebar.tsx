import type { ReactNode } from 'react';

import { SidebarTabs } from '../../shared/ui';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import type { WorkspaceEntryMutation } from '../../cheshiDesktop';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { normalizeSidebarPanel, type SidebarPanel } from './sidebarPanel';

export type WorkspaceView = 'chat' | 'notes' | 'calendar' | 'mail' | 'blank' | 'codegraph' | 'editor' | 'git' | 'plugins' | 'terminal' | 'search' | 'local-history' | 'settings';

interface SidebarProps {
  chatPanel?: ReactNode;
  activePanel?: SidebarPanel;
  onPanelChange?: (panel: SidebarPanel) => void;
  selectedFilePath: string | null;
  onWorkspaceEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenLocalHistory?: (path: string) => void;
}

export function Sidebar({
  chatPanel,
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
              { id: 'chats', label: 'Sessions', content: chatPanel },
              { id: 'files', label: 'Files', content: files },
              { id: 'memos', label: 'Memos', content: null },
            ]} /> : files}
        </div>

      </div>
    </aside>
  );
}
