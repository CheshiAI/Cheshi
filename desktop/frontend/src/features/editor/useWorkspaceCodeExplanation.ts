import type { EditorView } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import { cheshiDesktop as workspace } from '../../cheshiDesktop';
import {
  captureCodeExplanationSelection,
  createCodeExplanationSession,
  type CodeExplanationSelection,
  type CodeExplanationState,
} from './workspaceCodeExplanation';

export interface CodeExplanationMenuTarget {
  x: number;
  y: number;
  selection: CodeExplanationSelection | null;
  error: string | null;
}

interface UseWorkspaceCodeExplanationOptions {
  active: boolean;
  path: string | null;
  firstLine: number;
  editorViewRef: RefObject<EditorView | null>;
}

export function useWorkspaceCodeExplanation({ active, path, firstLine, editorViewRef }: UseWorkspaceCodeExplanationOptions) {
  const [menu, setMenu] = useState<CodeExplanationMenuTarget | null>(null);
  const [state, setState] = useState<CodeExplanationState | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const returnFocusRef = useRef<EditorView | null>(null);
  const session = useMemo(() => createCodeExplanationSession({
    explain: async (request) => {
      if (!workspace?.explainCode) throw new Error('Code explanation is unavailable. Restart Cheshi and try again.');
      return workspace.explainCode(request);
    },
    cancel: async (requestId) => { await workspace?.cancelCodeExplanation?.(requestId); },
    onChange: setState,
  }), []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    if (returnFocusRef.current === editorViewRef.current) returnFocusRef.current?.focus();
    returnFocusRef.current = null;
  }, [editorViewRef]);

  const dismiss = useCallback(() => {
    session.dismiss();
    setSelectionError(null);
  }, [session]);

  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => { setMenu(null); }, [active, path]);

  const hasSelectedCode = (target: EventTarget | null) => {
    const view = editorViewRef.current;
    return Boolean(view && target instanceof Node && view.contentDOM.contains(target) && !view.state.selection.main.empty);
  };

  const openMenu = (x: number, y: number) => {
    const view = editorViewRef.current;
    if (!view || !path || view.state.selection.main.empty) return;
    returnFocusRef.current = view;
    try {
      setMenu({ x, y, selection: captureCodeExplanationSelection(view.state, path, firstLine), error: null });
    } catch (error) {
      setMenu({ x, y, selection: null, error: errorMessage(error) });
    }
  };

  const explainSelection = () => {
    const target = menu;
    closeMenu();
    if (!target) return;
    setSelectionError(target.error);
    if (target.selection) void session.start(target.selection);
    else session.dismiss();
  };

  return {
    menu,
    state,
    selectionError,
    dismiss,
    closeMenu,
    explainSelection,
    hostHandlers: {
      onMouseDownCapture(event: MouseEvent<HTMLDivElement>) {
        if ((event.button === 2 || (event.button === 0 && event.ctrlKey)) && hasSelectedCode(event.target)) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onContextMenuCapture(event: MouseEvent<HTMLDivElement>) {
        if (!hasSelectedCode(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY);
      },
      onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
        if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) || !hasSelectedCode(event.target)) return;
        const view = editorViewRef.current;
        if (!view) return;
        event.preventDefault();
        event.stopPropagation();
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const bounds = view.contentDOM.getBoundingClientRect();
        openMenu(caret?.left ?? bounds.left, caret?.bottom ?? bounds.top);
      },
    },
  };
}
