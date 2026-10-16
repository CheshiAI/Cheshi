import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { elements, props, shellHarness } from './workspace-shell-test-harness';
import * as layoutModel from '../frontend/src/features/shell/workspaceLayoutModel';
import * as splitModel from '../frontend/src/shared/ui/splitPaneModel';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import type { SidebarRail } from '../frontend/src/features/navigation/SidebarRail';
import type { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import type { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatWorkspace } from '../frontend/src/features/chat/ChatWorkspace';

test('chat menu blur uses the layout containing both the session sidebar and workspace', () => {
  const app = shellHarness();
  const tree = app.render();
  const layout = elements(tree).find(element => element.type === 'div'
    && (element.props as ComponentProps<'div'>).className?.includes('app-layout'))!;
  const layoutProps = layout.props as ComponentProps<'div'>;
  const chat = props<ComponentProps<typeof ChatWorkspace>>(layoutProps.children, 'ChatWorkspace');
  expect(props<ComponentProps<typeof Sidebar>>(layoutProps.children, 'Sidebar').chatPanel).toBeDefined();
  expect(chat.menuBlurSourceRef).toBeDefined();
  expect(chat.menuBlurSourceRef).toBe(layoutProps.ref);
});

test.each(['chat', 'chats'] as const)('Codex and Worker coexist when opening a split from %s and survive rail navigation and closing', view => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const chats = () => props<ComponentProps<typeof ChatsView>>(app.render(), 'ChatsView');
  const codex = () => props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace');
  rail().onNavigate(view);
  const source = view === 'chat' ? 'primary' : 'worker', destination = view === 'chat' ? 'worker' : 'primary';
  const layout = layoutModel.placeWorkspacePane({ type: 'pane', paneId: source }, source, destination, 'right');
  split().onLayoutChange!(layout); split().onOpenPane!(destination);
  expect(chats().active).toBe(true); expect(codex().active).toBe(true);
  expect(rail().activeView).toBe(destination === 'worker' ? 'chats' : 'chat');
  rail().onNavigate('chats');
  expect(rail().activeView).toBe('chats'); expect(codex().active).toBe(true);
  rail().onNavigate('chat');
  expect(rail().activeView).toBe('chat'); expect(chats().active).toBe(true);
  expect(split().layout).toEqual(layout);
  chats().onCloseWorkspace!();
  expect(chats().active).toBe(false); expect(codex().active).toBe(true);
  expect(splitModel.splitPaneIds(split().layout!)).toEqual(['primary']);
  rail().onNavigate('chats');
  expect(chats().active).toBe(true); expect(codex().active).toBe(true);
  codex().onCloseWorkspace!();
  expect(codex().active).toBe(false); expect(chats().active).toBe(true);
  expect(rail().activeView).toBe('chats');
});

test('saved Worker splits restore both scenes and keep manual sidebar tabs independent', () => {
  const layout = layoutModel.placeWorkspacePane({ type: 'pane', paneId: 'primary' }, 'primary', 'worker', 'down');
  const app = shellHarness(false, { panel: 'files' }, layout);
  expect(props<ComponentProps<typeof ChatsView>>(app.render(), 'ChatsView').active).toBe(true);
  expect(props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace').active).toBe(true);
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  sidebar().onPanelChange!('agent-chats');
  expect(props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').activeView).toBe('chat');
  expect(sidebar().activePanel).toBe('agent-chats');
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit').layout).toEqual(layout);
});

test('opening a saved Codex conversation reveals its pane beside a saved Worker-only layout', () => {
  const app = shellHarness(false, { panel: 'files' }, { type: 'pane', paneId: 'worker' });
  const sidebar = props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  props<{ onOpen(id: string): void }>(sidebar.chatPanel, 'ChatSessionList').onOpen('saved-session');
  props<{ onOpened(): void }>(app.render(), 'ChatHistoryOpenDialog').onOpened();
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(splitModel.splitPaneIds(split.layout!)).toEqual(['worker', 'primary']);
  expect(props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace').active).toBe(true);
  expect(props<ComponentProps<typeof ChatsView>>(app.render(), 'ChatsView').active).toBe(true);
});

test('restoring Docker selects its Worker-hosted screen and returning to Worker keeps Codex visible', () => {
  const layout = layoutModel.placeWorkspacePane({ type: 'pane', paneId: 'primary' }, 'primary', 'worker', 'right');
  const app = shellHarness(false, { panel: 'files' }, layout);
  app.render(); app.restoreShell('docker', 'files'); app.render();
  expect(props<ComponentProps<typeof ChatsView>>(app.render(), 'ChatsView').active).toBe(false);
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chats');
  expect(props<ComponentProps<typeof ChatsView>>(app.render(), 'ChatsView').active).toBe(true);
  expect(props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace').active).toBe(true);
});
