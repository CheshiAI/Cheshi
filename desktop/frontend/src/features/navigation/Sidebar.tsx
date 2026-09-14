import {
  Bell,
  Blocks,
  Crosshair,
  PanelsTopLeft,
  Search,
  SquareTerminal,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { NeumorphicButton } from '../../shared/ui';
import type { WorkspaceEntryMutation } from '../../cheshiDesktop';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { WorkspaceSelector } from './WorkspaceSelector';

export type WorkspaceView = 'chat' | 'blank' | 'codegraph' | 'editor' | 'git' | 'plugins' | 'terminal' | 'search' | 'showcase' | 'local-history';

const navigationItems: Array<{ label: string; icon: ReactNode; view: WorkspaceView }> = [
  { label: 'Codex', icon: <span className="navigation-openai-mark" aria-hidden="true" />, view: 'chat' },
  { label: 'Relationship Graph', icon: <Crosshair aria-hidden="true" />, view: 'codegraph' },
  { label: 'Terminal', icon: <SquareTerminal aria-hidden="true" />, view: 'terminal' },
  { label: 'Github', icon: <span className="navigation-github-mark" aria-hidden="true" />, view: 'git' },
  { label: 'Plugins', icon: <Blocks aria-hidden="true" />, view: 'plugins' },
  { label: 'Showcase', icon: <PanelsTopLeft aria-hidden="true" />, view: 'showcase' },
];

interface SidebarProps {
  activeView: WorkspaceView;
  selectedFilePath: string | null;
  onNavigate: (view: WorkspaceView) => void;
  onWorkspaceEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenLocalHistory?: (path: string) => void;
}

export function Sidebar({
  activeView,
  selectedFilePath,
  onNavigate,
  onWorkspaceEntryMutation,
  onOpenWorkspaceFile,
  onOpenLocalHistory,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-panel-content">
        <div className="sidebar-content-primary">
          <WorkspaceFileTree
            selectedPath={selectedFilePath}
            onEntryMutation={onWorkspaceEntryMutation}
            onOpenFile={onOpenWorkspaceFile}
            onOpenLocalHistory={onOpenLocalHistory}
          />
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
