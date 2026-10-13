import { expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { WorkspaceView } from '../frontend/src/features/navigation/Sidebar';

const { SidebarRail } = await import('../frontend/src/features/navigation/SidebarRail');
const { KeepAwakeButton } = await import('../frontend/src/features/chrome/KeepAwakeButton');
const { HelpCenter } = await import('../frontend/src/features/help/HelpCenter');
const { WorkspaceSelector } = await import('../frontend/src/features/navigation/WorkspaceSelector');
const { SidebarRailButton } = await import('../frontend/src/shared/ui/SidebarRailButton');

type ElementProps = {
  children?: ReactNode;
  onClick?: () => void;
  'aria-current'?: string;
  'aria-label'?: string;
  'aria-controls'?: string;
  'aria-expanded'?: boolean;
  'data-active'?: string;
  active?: boolean;
  label?: string;
  variant?: string;
};
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}

test('SESSION rail item uses page navigation when returning from another view or selecting it again', () => {
  for (const activeView of ['notes', 'calendar', 'terminal', 'git', 'plugins', 'editor', 'codegraph', 'chat', 'search'] as const) {
    const destinations: WorkspaceView[] = [];
    const rail = SidebarRail({ activeView, sidebarOpen: true,
      onNavigate: view => destinations.push(view), onToggleSidebar() {} });
    const session = elements(rail).find(element => element.type === SidebarRailButton && element.props.label === 'SESSION');
    expect(session).toBeDefined();
    session?.props.onClick?.();
    expect(destinations).toEqual(['chat']);
    expect(session?.props.active).toBe(activeView === 'chat');
    expect(session?.props['aria-current']).toBe(activeView === 'chat' ? 'page' : undefined);
    expect(session?.props['aria-label']).toBe('SESSION');
  }
});

test('rail management items retain their order and destinations', () => {
  const destinations: WorkspaceView[] = [];
  const rail = SidebarRail({ activeView: 'chat', sidebarOpen: true,
    onNavigate: view => destinations.push(view), onToggleSidebar() {} });
  const navigation = elements(rail).filter(element => element.type === SidebarRailButton).slice(0, 10);
  expect(navigation.map(element => element.props.label)).toEqual([
      'Explorer', 'SESSION', 'Worker', 'Terminal', 'Memo',
      'Calendar', 'Docker', 'Github', 'Plugins', 'Settings',
    ]);
  for (const element of navigation) if (element.props.label !== 'SESSION') element.props.onClick?.();
  expect(destinations).toEqual(['explorer', 'chats', 'terminal', 'notes', 'calendar', 'docker', 'git', 'plugins', 'settings']);
});

test('rail bottom controls retain caffeine, sidebar and project actions without a help launcher', () => {
  let toggles = 0;
  const rail = SidebarRail({ activeView: 'chat', sidebarOpen: true,
    onNavigate() {}, onToggleSidebar() { toggles++; } });
  expect(elements(rail).find(element => element.type === KeepAwakeButton)?.props.variant).toBe('rail');
  expect(elements(rail).some(element => element.type === HelpCenter)).toBe(false);
  expect(elements(rail).some(element => element.type === WorkspaceSelector)).toBe(true);
  const collapse = elements(rail).find(element => element.type === SidebarRailButton && element.props.label === 'Collapse sidebar');
  expect(collapse?.props['aria-label']).toBe('Collapse sidebar');
  collapse?.props.onClick?.();
  expect(toggles).toBe(1);
});

test('only the focused view has an active rail icon even when the sidebar is collapsed', () => {
  for (const sidebarOpen of [true, false]) {
    for (const activeView of ['explorer', 'editor', 'chat', 'terminal', 'notes', 'git'] as const) {
      const destinations: WorkspaceView[] = [];
      const rail = SidebarRail({ activeView, sidebarOpen,
        onNavigate: view => destinations.push(view), onToggleSidebar() {} });
      const navigation = elements(rail).filter(element => element.type === SidebarRailButton).slice(0, 10);
      expect(navigation.filter(element => element.props.active)).toHaveLength(1);
      const explorer = elements(rail).find(element => element.type === SidebarRailButton);
      expect(explorer?.props.label).toBe('Explorer');
      expect(explorer?.props.active).toBe(activeView === 'explorer' || activeView === 'editor');
      expect(explorer?.props['aria-expanded']).toBe(sidebarOpen);
      expect(explorer?.props['aria-controls']).toBe('workspace-sidebar');
      explorer?.props.onClick?.();
      expect(destinations).toEqual(['explorer']);
    }
  }
});
