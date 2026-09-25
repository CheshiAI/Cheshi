import type { EditorView } from '@codemirror/view';
import { MAX_BLAME_CONTENT_LENGTH, type GitLineBlameRequest } from '../../../../shared/git-line-blame';
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
  lineRequest: GitLineBlameRequest | null;
}

interface UseWorkspaceCodeExplanationOptions {
  active: boolean;
  path: string | null;
  firstLine: number;
  lineEnding?: 'lf' | 'crlf' | 'cr' | null;
  editorViewRef: RefObject<EditorView | null>;
}

export function useWorkspaceCodeExplanation({ active, path, firstLine, lineEnding, editorViewRef }: UseWorkspaceCodeExplanationOptions) {
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

  const canInspectLine = (target: EventTarget | null) => {
    const view = editorViewRef.current;
    return Boolean(view && lineEnding && target instanceof Node && view.contentDOM.contains(target));
  };

  const openMenu = (x: number, y: number, position: number | null) => {
    const view = editorViewRef.current;
    if (!view || !path) return;
    const lineRequest = lineEnding && lineEnding !== 'cr' && position !== null && view.state.doc.length <= MAX_BLAME_CONTENT_LENGTH
      ? { path, line: view.state.doc.lineAt(position).number,
        content: view.state.doc.sliceString(0, undefined, lineEnding === 'crlf' ? '\r\n' : '\n') } : null;
    returnFocusRef.current = view;
    try {
      const selection = view.state.selection.main.empty ? null : captureCodeExplanationSelection(view.state, path, firstLine);
      setMenu({ x, y, selection, error: null, lineRequest });
    } catch (error) {
      setMenu({ x, y, selection: null, error: errorMessage(error), lineRequest });
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

  const explainCurrentSelection = () => {
    const view = editorViewRef.current;
    if (!active || !view || !path) return;
    try {
      const selection = captureCodeExplanationSelection(view.state, path, firstLine);
      setSelectionError(null);
      void session.start(selection);
    } catch (error) {
      session.dismiss();
      setSelectionError(errorMessage(error));
    }
  };

  return {
    explainCurrentSelection,
    menu,
    state,
    selectionError,
    dismiss,
    closeMenu,
    explainSelection,
    showLineCommit: (open: (request: GitLineBlameRequest) => void) => {
      const request = menu?.lineRequest;
      closeMenu();
      if (request) open(request);
    },
    hostHandlers: {
      onMouseDownCapture(event: MouseEvent<HTMLDivElement>) {
        if ((event.button === 2 || (event.button === 0 && event.ctrlKey)) && hasSelectedCode(event.target)) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onContextMenuCapture(event: MouseEvent<HTMLDivElement>) {
        if (!hasSelectedCode(event.target) && !canInspectLine(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY, editorViewRef.current?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null);
      },
      onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
        if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
          || (!hasSelectedCode(event.target) && !canInspectLine(event.target))) return;
        const view = editorViewRef.current;
        if (!view) return;
        event.preventDefault();
        event.stopPropagation();
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const bounds = view.contentDOM.getBoundingClientRect();
        openMenu(caret?.left ?? bounds.left, caret?.bottom ?? bounds.top, view.state.selection.main.head);
      },
    },
  };
}
