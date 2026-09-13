import { expect, mock, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
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
  for (const activeView of ['terminal', 'git', 'plugins', 'editor', 'codegraph', 'chat', 'search', 'showcase'] as const) {
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
  const sidebar = Sidebar({ activeView: 'chat', selectedFilePath: null, onNavigate: view => destinations.push(view),
    onWorkspaceEntryMutation() {}, onOpenWorkspaceFile() {} });
  for (const element of elements(sidebar)) {
    if (element.type === 'button' && element.key !== 'Codex') element.props.onClick?.();
  }
  expect(destinations).toEqual(['codegraph', 'terminal', 'git', 'plugins', 'showcase']);
});
