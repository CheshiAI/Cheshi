import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { props, shellHarness } from './workspace-shell-test-harness';
import { placeWorkspacePane } from '../frontend/src/features/shell/workspaceLayoutModel';
import type { SplitLayoutNode } from '../frontend/src/shared/ui/splitPaneModel';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import type { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import type { SidebarRail } from '../frontend/src/features/navigation/SidebarRail';
import type { WorkspaceEditor } from '../frontend/src/features/editor/WorkspaceEditor';
import type { ChatWorkspace } from '../frontend/src/features/chat/ChatWorkspace';

for (const axis of ['columns', 'rows'] as const) {
  test(`file opening preserves the previous ${axis} layout and leaves splitting to explicit controls`, () => {
    const layout: SplitLayoutNode = { type: 'split', id: 'conversation-worker', axis, ratio: .67,
      first: { type: 'pane', paneId: 'primary' }, second: { type: 'pane', paneId: 'worker' } };
    const app = shellHarness(false, { panel: 'chats' }, layout);
    const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
    const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
    const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
    const chat = () => props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace');
    const workspace = chat().workspace;
    sidebar().onOpenWorkspaceFile('unsaved.ts');
    expect(split().layout).toEqual({ type: 'pane', paneId: 'editor' });
    expect(chat().active).toBe(false);
    expect(chat().workspace.activePaneId).toBe(workspace.activePaneId);
    editor().onDirtyPathsChange?.(['unsaved.ts']);
    sidebar().onOpenWorkspaceFile('second.ts');
    expect(editor().target?.path).toBe('second.ts');
    expect(split().layout).toEqual({ type: 'pane', paneId: 'editor' });
    props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
    expect(split().layout).toBe(layout);
    expect(editor().target?.path).toBe('second.ts');
    expect(chat().active).toBe(true);
    sidebar().onOpenWorkspaceFile('third.ts');
    editor().onAllTabsClosed();
    expect(split().layout).toBe(layout);
    expect(editor().target).toBeNull();
    sidebar().onOpenWorkspaceFile('fourth.ts');
    const explicit = placeWorkspacePane(split().layout!, 'editor', 'primary', 'right');
    split().onLayoutChange!(explicit);
    split().onOpenPane!('primary');
    expect(split().layout).toEqual(explicit);
    expect(chat().active).toBe(true);
    sidebar().onOpenWorkspaceFile('fifth.ts');
    expect(split().layout).toEqual(explicit);
    expect(editor().target?.path).toBe('fifth.ts');
  });
}

test('opening an Explorer file and returning to chat never creates an implicit split', () => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('draft.ts');
  expect(split().mode).toBe('editor');
  rail().onNavigate('chat');
  expect(split().mode).toBe('primary');
  expect(split().layout).toBeNull();
  expect(props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor').target?.path).toBe('draft.ts');
  rail().onNavigate('explorer');
  expect(split().layout).toEqual({ type: 'pane', paneId: 'editor' });
  rail().onNavigate('chat');
  expect(split().mode).toBe('primary');
  expect(split().layout).toBeNull();
});
