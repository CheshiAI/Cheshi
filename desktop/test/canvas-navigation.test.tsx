import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { CanvasView } from '../frontend/src/features/canvas/CanvasView';
import type { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import type { SidebarRail } from '../frontend/src/features/navigation/SidebarRail';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import { props, shellHarness } from './workspace-shell-test-harness';

for (const view of ['explorer', 'chat', 'terminal', 'git'] as const) {
  test(`Canvas sidebar selection preserves the ${view} workspace and rail selection`, () => {
    const app = shellHarness();
    const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
    const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
    rail().onNavigate(view);
    const before = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
    const selectedView = rail().activeView;
    sidebar().onPanelChange!('canvas');
    expect(sidebar().activePanel).toBe('canvas');
    expect(rail().activeView).toBe(selectedView);
    const after = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
    expect(after.mode).toBe(before.mode);
    expect(after.layout).toEqual(before.layout);
    const canvas = props<ComponentProps<typeof CanvasView>>(app.render(), 'CanvasView');
    expect(canvas.active).toBe(false);
    expect(canvas.target).toBeNull();
    sidebar().onPanelChange!('files');
    sidebar().onPanelChange!('canvas');
    expect(rail().activeView).toBe(selectedView);
  });
}

test('opening a Canvas sidebar file activates its workspace and passes the document request', () => {
  const app = shellHarness();
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const canvas = () => props<ComponentProps<typeof CanvasView>>(app.render(), 'CanvasView');
  rail().onNavigate('chat');
  sidebar().onPanelChange!('canvas');
  canvas().onOpenFile('designs/one.fig');
  expect(rail().activeView).toBe('canvas');
  expect(canvas().active).toBe(true);
  expect(canvas().target?.path).toBe('designs/one.fig');
  const requestId = canvas().target!.requestId;
  rail().onNavigate('chat');
  sidebar().onPanelChange!('canvas');
  expect(rail().activeView).toBe('chat');
  expect(canvas().target?.requestId).toBe(requestId);
  canvas().onOpenFile('designs/one.fig');
  expect(canvas().target!.requestId).toBeGreaterThan(requestId);
  expect(canvas().active).toBe(true);
});

test('Canvas tab preserves a split workspace, while the Canvas rail still navigates', () => {
  const layout = { type: 'split' as const, id: 'primary-terminal', axis: 'columns' as const, ratio: .6,
    first: { type: 'pane' as const, paneId: 'primary' }, second: { type: 'pane' as const, paneId: 'terminal' } };
  const app = shellHarness(false, { panel: 'files' }, layout);
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  rail().onNavigate('terminal');
  sidebar().onPanelChange!('canvas');
  expect(rail().activeView).toBe('terminal');
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit').layout).toEqual(layout);
  rail().onNavigate('canvas');
  expect(rail().activeView).toBe('canvas');
  expect(sidebar().activePanel).toBe('canvas');
  expect(props<ComponentProps<typeof CanvasView>>(app.render(), 'CanvasView').active).toBe(true);
});
