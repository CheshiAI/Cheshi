import {
  Bell,
  CalendarDays,
  Mail,
  Blocks,
  Crosshair,
  PanelsTopLeft,
  Search,
  Settings,
  SquareTerminal,
  StickyNote,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { NeumorphicButton, SidebarCarousel } from '../../shared/ui';
import type { WorkspaceEntryMutation } from '../../cheshiDesktop';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { WorkspaceSelector } from './WorkspaceSelector';

export type WorkspaceView = 'chat' | 'notes' | 'calendar' | 'mail' | 'blank' | 'codegraph' | 'editor' | 'git' | 'plugins' | 'terminal' | 'search' | 'showcase' | 'local-history' | 'settings';

const navigationItems: Array<{ label: string; icon: ReactNode; view: WorkspaceView }> = [
  { label: 'Relationship Graph', icon: <Crosshair aria-hidden="true" />, view: 'codegraph' },
  { label: 'Codex', icon: <span className="navigation-openai-mark" aria-hidden="true" />, view: 'chat' },
  { label: 'Memo', icon: <StickyNote aria-hidden="true" />, view: 'notes' },
  { label: 'Calendar', icon: <CalendarDays aria-hidden="true" />, view: 'calendar' },
  { label: 'Mail', icon: <Mail aria-hidden="true" />, view: 'mail' },
  { label: 'Terminal', icon: <SquareTerminal aria-hidden="true" />, view: 'terminal' },
  { label: 'Github', icon: <span className="navigation-github-mark" aria-hidden="true" />, view: 'git' },
  { label: 'Plugins', icon: <Blocks aria-hidden="true" />, view: 'plugins' },
  { label: 'Showcase', icon: <PanelsTopLeft aria-hidden="true" />, view: 'showcase' },
  { label: 'Settings', icon: <Settings aria-hidden="true" />, view: 'settings' },
];

interface SidebarProps {
  chatPanel?: ReactNode;
  activePanel?: 'files' | 'chats';
  onPanelChange?: (panel: 'files' | 'chats') => void;
  activeView: WorkspaceView;
  selectedFilePath: string | null;
  onNavigate: (view: WorkspaceView) => void;
  onWorkspaceEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenLocalHistory?: (path: string) => void;
}

export function Sidebar({
  chatPanel,
  activePanel = 'files',
  onPanelChange,
  activeView,
  selectedFilePath,
  onNavigate,
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

        <div className="sidebar-content-secondary">
          <div className="sidebar-heading">
            <span className="sidebar-section-heading">MANAGEMENTS</span>
            <div className="sidebar-heading-actions" hidden>
              <NeumorphicButton raised className="sidebar-heading-action" aria-label="Search"><Search aria-hidden="true" /></NeumorphicButton>
              <NeumorphicButton raised className="sidebar-heading-action" aria-label="Notifications"><Bell aria-hidden="true" /></NeumorphicButton>
            </div>
          </div>

          <nav className="primary-navigation" aria-label="Primary navigation">
            {navigationItems.map((item) => (
              <button
                className="navigation-item"
                data-active={item.view === activeView ? 'true' : undefined}
                key={item.label}
                type="button"
                onClick={() => onNavigate(item.view)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>

      <footer className="sidebar-footer">
        <WorkspaceSelector />
      </footer>
    </aside>
  );
}
