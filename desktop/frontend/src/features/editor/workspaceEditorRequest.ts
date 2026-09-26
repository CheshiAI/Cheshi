import type { EditorView } from '@codemirror/view';
import type { RefObject } from 'react';

export interface WorkspaceEditorRequest {
  isCurrent: () => boolean;
}

// Invalidating a request discards its result; it does not undo a dispatched write.
export function createWorkspaceRequestTracker() {
  let generation = 0;
  let current: WorkspaceEditorRequest | null = null;
  return {
    invalidate: () => { generation += 1; current = null; },
    current: () => current,
    begin(validate: () => boolean): WorkspaceEditorRequest {
      const request = ++generation;
      current = { isCurrent: () => generation === request && validate() };
      return current;
    },
  };
}

export type WorkspaceRequestTracker = ReturnType<typeof createWorkspaceRequestTracker>;

export function beginWorkspaceEditorRequest(
  tracker: WorkspaceRequestTracker,
  view: EditorView,
  path: string,
  editorViewRef: RefObject<EditorView | null>,
  editorPathRef: RefObject<string | null>,
): WorkspaceEditorRequest {
  const document = view.state.doc;
  return tracker.begin(() => editorViewRef.current === view
    && editorPathRef.current === path && view.state.doc === document);
}
