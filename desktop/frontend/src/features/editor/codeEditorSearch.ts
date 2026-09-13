import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import type { Command, EditorView, Panel } from '@codemirror/view';
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';

export interface EditorSearchControls {
  search: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

const initialEditorSearchControls: EditorSearchControls = {
  search: '',
  replace: '',
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
};

function createEditorSearchQuery(controls: EditorSearchControls): SearchQuery {
  return new SearchQuery(controls);
}

function searchControlsFromQuery(query: SearchQuery): EditorSearchControls {
  return {
    search: query.search,
    replace: query.replace,
    caseSensitive: query.caseSensitive,
    regexp: query.regexp,
    wholeWord: query.wholeWord,
  };
}

export function createEditorSearchBridgePanel(): Panel {
  const dom = document.createElement('div');
  dom.dataset.codeEditorSearchBridge = '';
  dom.hidden = true;
  dom.setAttribute('aria-hidden', 'true');
  return { dom, top: true };
}

export function useCodeEditorSearch(editorViewRef: RefObject<EditorView | null>) {
  const [editorSearchOpen, setEditorSearchOpen] = useState(false);
  const [editorSearchControls, setEditorSearchControls] = useState(initialEditorSearchControls);
  const editorSearchInputRef = useRef<HTMLInputElement>(null);
  const editorSearchOpenRef = useRef(editorSearchOpen);
  const editorSearchControlsRef = useRef(editorSearchControls);

  editorSearchOpenRef.current = editorSearchOpen;
  editorSearchControlsRef.current = editorSearchControls;

  const updateEditorSearchControls = useCallback((update: Partial<EditorSearchControls>): void => {
    const next = { ...editorSearchControlsRef.current, ...update };
    editorSearchControlsRef.current = next;
    setEditorSearchControls(next);
    const view = editorViewRef.current;
    if (view) view.dispatch({ effects: setSearchQuery.of(createEditorSearchQuery(next)) });
  }, [editorViewRef]);

  const openEditorSearch = useCallback((view: EditorView): boolean => {
    openSearchPanel(view);
    const next = searchControlsFromQuery(getSearchQuery(view.state));
    editorSearchControlsRef.current = next;
    editorSearchOpenRef.current = true;
    setEditorSearchControls(next);
    setEditorSearchOpen(true);
    requestAnimationFrame(() => {
      const input = editorSearchInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return true;
  }, []);

  const closeEditorSearch = useCallback((): void => {
    const clearedControls = {
      ...editorSearchControlsRef.current,
      search: '',
      replace: '',
    };
    editorSearchControlsRef.current = clearedControls;
    editorSearchOpenRef.current = false;
    setEditorSearchControls(clearedControls);
    setEditorSearchOpen(false);
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({ effects: setSearchQuery.of(createEditorSearchQuery(clearedControls)) });
    closeSearchPanel(view);
    view.focus();
  }, [editorViewRef]);

  const runEditorSearchCommand = useCallback((command: Command): void => {
    const view = editorViewRef.current;
    if (!view) return;
    command(view);
    requestAnimationFrame(() => editorSearchInputRef.current?.focus());
  }, [editorViewRef]);

  const syncEditorSearchPanel = useCallback((view: EditorView): void => {
    if (editorSearchOpenRef.current) {
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(createEditorSearchQuery(editorSearchControlsRef.current)) });
      requestAnimationFrame(() => editorSearchInputRef.current?.focus());
    } else {
      closeSearchPanel(view);
    }
  }, []);

  const editorSearchQueryValid = useMemo(
    () => createEditorSearchQuery(editorSearchControls).valid,
    [editorSearchControls],
  );

  return {
    editorSearchOpen,
    editorSearchControls,
    editorSearchInputRef,
    editorSearchQueryValid,
    updateEditorSearchControls,
    openEditorSearch,
    closeEditorSearch,
    runEditorSearchCommand,
    syncEditorSearchPanel,
  };
}
