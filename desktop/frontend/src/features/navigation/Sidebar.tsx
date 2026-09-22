import type { ReactNode } from 'react';

import { SidebarCarousel } from '../../shared/ui';
import type { WorkspaceEntryMutation } from '../../cheshiDesktop';
import { WorkspaceFileTree } from './WorkspaceFileTree';

export type WorkspaceView = 'chat' | 'notes' | 'calendar' | 'mail' | 'blank' | 'codegraph' | 'editor' | 'git' | 'plugins' | 'terminal' | 'search' | 'showcase' | 'local-history' | 'settings';

interface SidebarProps {
  chatPanel?: ReactNode;
  activePanel?: 'files' | 'chats';
  onPanelChange?: (panel: 'files' | 'chats') => void;
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
  const files = <WorkspaceFileTree selectedPath={selectedFilePath}
    onEntryMutation={onWorkspaceEntryMutation} onOpenFile={onOpenWorkspaceFile} onOpenLocalHistory={onOpenLocalHistory} />;
  return (
    <aside className="sidebar">
      <div className="sidebar-panel-content">
        <div className="sidebar-content-primary">
          {chatPanel && onPanelChange ? <SidebarCarousel activeId={activePanel}
            onSelect={panel => { if (panel === 'files' || panel === 'chats') onPanelChange(panel); }}
            slides={[{ id: 'files', label: 'Files', content: files }, { id: 'chats', label: 'Chats', content: chatPanel }]} /> : files}
        </div>

      </div>
    </aside>
  );
}
