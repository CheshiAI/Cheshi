import {
  Blocks,
  CalendarDays,
  Crosshair,
  Mail,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  Settings,
  SquareTerminal,
  StickyNote,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { SidebarRailButton } from '../../shared/ui';
import { KeepAwakeButton } from '../chrome/KeepAwakeButton';
import { HelpCenter } from '../help/HelpCenter';
import type { WorkspaceView } from './Sidebar';
import { WorkspaceSelector } from './WorkspaceSelector';
import styles from './SidebarRail.module.css';

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

export function SidebarRail({ activeView, sidebarOpen, onNavigate, onToggleSidebar }: {
  activeView: WorkspaceView;
  sidebarOpen: boolean;
  onNavigate(view: WorkspaceView): void;
  onToggleSidebar(): void;
}) {
  return <>
    <div className={styles.chrome} aria-hidden="true" />
    <nav className={styles.navigation} aria-label="Primary navigation">
      {navigationItems.map(item => {
        const active = item.view === activeView;
        return <SidebarRailButton key={item.label} active={active} icon={item.icon} label={item.label}
          aria-label={item.label} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item.view)} />;
      })}
    </nav>
    <div className={styles.bottomControls} aria-label="Workspace controls">
      <KeepAwakeButton variant="rail" />
      <HelpCenter variant="rail" />
      <SidebarRailButton active={!sidebarOpen}
        icon={sidebarOpen ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
        label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-controls="workspace-sidebar" aria-expanded={sidebarOpen} onClick={onToggleSidebar} />
      <WorkspaceSelector />
    </div>
  </>;
}
