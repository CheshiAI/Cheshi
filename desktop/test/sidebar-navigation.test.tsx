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

test('Codex rail item uses page navigation when returning from another view or selecting it again', () => {
  for (const activeView of ['notes', 'calendar', 'mail', 'terminal', 'git', 'plugins', 'editor', 'codegraph', 'chat', 'search', 'showcase'] as const) {
    const destinations: WorkspaceView[] = [];
    const rail = SidebarRail({ activeView, sidebarOpen: true, onNavigate: view => destinations.push(view), onToggleSidebar() {} });
    const codex = elements(rail).find(element => element.type === SidebarRailButton && element.props.label === 'Codex');
    expect(codex).toBeDefined();
    codex?.props.onClick?.();
    expect(destinations).toEqual(['chat']);
    expect(codex?.props.active).toBe(activeView === 'chat');
    expect(codex?.props['aria-current']).toBe(activeView === 'chat' ? 'page' : undefined);
    expect(codex?.props['aria-label']).toBe('Codex');
  }
});

test('rail management items retain their order and destinations', () => {
  const destinations: WorkspaceView[] = [];
  const rail = SidebarRail({ activeView: 'chat', sidebarOpen: true,
    onNavigate: view => destinations.push(view), onToggleSidebar() {} });
  const navigation = elements(rail).filter(element => element.type === SidebarRailButton).slice(0, 10);
  expect(navigation.map(element => element.props.label)).toEqual([
      'Relationship Graph', 'Codex', 'Memo', 'Calendar', 'Mail',
      'Terminal', 'Github', 'Plugins', 'Showcase', 'Settings',
    ]);
  for (const element of navigation) if (element.props.label !== 'Codex') element.props.onClick?.();
  expect(destinations).toEqual(['codegraph', 'notes', 'calendar', 'mail', 'terminal', 'git', 'plugins', 'showcase', 'settings']);
});

test('rail bottom controls expose caffeine, help, sidebar and project actions', () => {
  let toggles = 0;
  const rail = SidebarRail({ activeView: 'chat', sidebarOpen: true, onNavigate() {}, onToggleSidebar() { toggles++; } });
  expect(elements(rail).find(element => element.type === KeepAwakeButton)?.props.variant).toBe('rail');
  expect(elements(rail).find(element => element.type === HelpCenter)?.props.variant).toBe('rail');
  expect(elements(rail).some(element => element.type === WorkspaceSelector)).toBe(true);
  const collapse = elements(rail).find(element => element.type === SidebarRailButton && element.props.label === 'Collapse sidebar');
  expect(collapse?.props['aria-label']).toBe('Collapse sidebar');
  collapse?.props.onClick?.();
  expect(toggles).toBe(1);
});
