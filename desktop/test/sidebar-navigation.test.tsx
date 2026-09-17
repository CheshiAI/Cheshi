import { expect, mock, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceView } from '../frontend/src/features/navigation/Sidebar';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { Sidebar } = await import('../frontend/src/features/navigation/Sidebar');

type ElementProps = { children?: ReactNode; onClick?: () => void; 'data-active'?: string };
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}

test('Codex uses page navigation when returning from another view or selecting it again', () => {
  for (const activeView of ['notes', 'terminal', 'git', 'plugins', 'editor', 'codegraph', 'chat', 'search', 'showcase', 'autopilot'] as const) {
    const destinations: WorkspaceView[] = [];
    const sidebar = Sidebar({ activeView, selectedFilePath: null, onNavigate: view => destinations.push(view),
      onWorkspaceEntryMutation() {}, onOpenWorkspaceFile() {} });
    const codex = elements(sidebar).find(element => element.type === 'button' && element.key === 'Codex');
    expect(codex).toBeDefined();
    codex?.props.onClick?.();
    expect(destinations).toEqual(['chat']);
    expect(codex?.props['data-active']).toBe(activeView === 'chat' ? 'true' : undefined);
  }
});

test('other management entries retain their destinations', () => {
  const destinations: WorkspaceView[] = [];
  const sidebar = Sidebar({ autopilotMenuVisible: true, activeView: 'chat', selectedFilePath: null, onNavigate: view => destinations.push(view),
    onWorkspaceEntryMutation() {}, onOpenWorkspaceFile() {} });
  for (const element of elements(sidebar)) {
    if (element.type === 'button' && element.key !== 'Codex') element.props.onClick?.();
  }
  expect(destinations).toEqual(['codegraph', 'notes', 'terminal', 'git', 'plugins', 'showcase', 'autopilot', 'settings']);
});

test('Autopilot precedes Settings and carries its beta label', () => {
  const destinations: WorkspaceView[] = [];
  const sidebar = Sidebar({ autopilotMenuVisible: true, activeView: 'autopilot', selectedFilePath: null, onNavigate: view => destinations.push(view),
    onWorkspaceEntryMutation() {}, onOpenWorkspaceFile() {} });
  const entries = elements(sidebar).filter(element => element.props.onClick);
  const autopilot = entries.at(-2)!;
  expect(entries.at(-1)?.key).toBe('Settings');
  expect(autopilot.key).toBe('Autopilot');
  expect(autopilot.props['data-active']).toBe('true');
  expect(renderToStaticMarkup(autopilot)).toContain('beta');
  autopilot.props.onClick?.();
  expect(destinations).toEqual(['autopilot']);
});

test('hiding Autopilot preserves Settings and the other navigation entries', () => {
  const render = (autopilotMenuVisible: boolean) => elements(Sidebar({ autopilotMenuVisible,
    activeView: 'settings', selectedFilePath: null, onNavigate() {},
    onWorkspaceEntryMutation() {}, onOpenWorkspaceFile() {},
  })).filter(element => element.type === 'button' && element.key !== null).map(element => element.key);
  const visible = render(true);
  const hidden = render(false);
  expect(visible).toContain('Autopilot');
  expect(hidden).not.toContain('Autopilot');
  expect(hidden).toEqual(visible.filter(key => key !== 'Autopilot'));
  expect(hidden.at(-1)).toBe('Settings');
});
