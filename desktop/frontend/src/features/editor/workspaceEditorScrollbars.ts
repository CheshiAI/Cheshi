import { ViewPlugin } from '@codemirror/view';
import { installAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';

export const workspaceEditorScrollbars = ViewPlugin.define(view => {
  const cleanup = installAutoHideScrollbars(view.scrollDOM);
  return { destroy: cleanup };
});
