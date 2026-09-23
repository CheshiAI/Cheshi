import { autocompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { search } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  closeHoverTooltip,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import { cheshiDesktop as workspace } from '../../cheshiDesktop';
import { bracketPairGuides } from './bracketPairGuides';
import { gitLineBlame } from './gitLineBlame';
import { createEditorSearchBridgePanel } from './codeEditorSearch';
import { languageServerLanguageForPath } from './languageServerDiagnostics';
import type { WorkspaceEditorAssistState } from './WorkspaceEditorAssistPanel';
import type { WorkspaceDiagnostic } from './workspaceDiagnostics';
import {
  definitionLinkRangeField,
  definitionModifierPressed,
  diagnosticMode,
  languageServerHoverTooltip,
  languageSupport,
  setDefinitionLinkRange,
  setSignatureHelpTooltip,
  signatureHelpTooltipField,
  type DefinitionLinkRange,
  type WorkspaceTab,
} from './workspaceEditorModel';
import { workspaceEditorHighlightStyle, workspaceEditorTheme } from './workspaceEditorTheme';
import { workspaceEditorContentClip } from './workspaceEditorContentClip';
import { workspaceEditorScrollbars } from './workspaceEditorScrollbars';
import type { WorkspaceLanguageServerController } from './useWorkspaceLanguageServer';

interface UseWorkspaceCodeEditorOptions {
  activateOpenTab: (path: string) => void;
  assistStateRef: RefObject<WorkspaceEditorAssistState | null>;
  editorHostRef: RefObject<HTMLDivElement | null>;
  editorPathRef: RefObject<string | null>;
  editorViewRef: RefObject<EditorView | null>;
  languageServer: WorkspaceLanguageServerController;
  navigateHistory: (direction: 'back' | 'forward') => Promise<void>;
  openEditorSearch: (view: EditorView) => boolean;
  recordNavigationOrigin: () => void;
  setAssistState: Dispatch<SetStateAction<WorkspaceEditorAssistState | null>>;
  syncEditorSearchPanel: (view: EditorView) => void;
  tabsRef: RefObject<WorkspaceTab[]>;
  updateTab: (path: string, update: (tab: WorkspaceTab) => WorkspaceTab) => void;
}

export function useWorkspaceCodeEditor({
  activateOpenTab,
  assistStateRef,
  editorHostRef,
  editorPathRef,
  editorViewRef,
  languageServer,
  navigateHistory,
  openEditorSearch,
  recordNavigationOrigin,
  setAssistState,
  syncEditorSearchPanel,
  tabsRef,
  updateTab,
}: UseWorkspaceCodeEditorOptions) {
  const {
    cancelDiagnostics,
    cancelSignatureHelp,
    isLanguageServerUsable,
    languageServerCompletionSource,
    requestLanguageServerCodeActions,
    requestLanguageServerDefinition,
    requestLanguageServerHover,
    requestLanguageServerReferences,
    requestLanguageServerRename,
    requestLanguageServerSignatureHelp,
    resetLanguageServerRequests,
    resolveLanguageServerDefinitionLocations,
    scheduleEditorDiagnostics,
  } = languageServer;

  const destroyEditor = useCallback((captureState = true, closeLanguageServerDocument = true): void => {
    resetLanguageServerRequests();
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        setDefinitionLinkRange.of(null),
        setSignatureHelpTooltip.of(null),
      ],
    });
    const path = editorPathRef.current;
    const language = path ? languageServerLanguageForPath(path) : null;
    if (path && language && closeLanguageServerDocument) {
      void workspace?.closeLanguageServerDocument?.({ language, path });
    }
    if (path && captureState) {
      updateTab(path, (tab) => ({
        ...tab,
        editorState: view.state,
        draftContent: view.state.doc.toString(),
      }));
    }
    view.destroy();
    editorViewRef.current = null;
    editorPathRef.current = null;
  }, [resetLanguageServerRequests, updateTab]);

  const saveFileRef = useRef<() => Promise<void>>(async () => undefined);
  const closeTabRef = useRef<(path: string | null) => void>(() => undefined);

  const revealLine = useCallback((
    lineNumber: number | null | undefined,
    character = 0,
  ): void => {
    const view = editorViewRef.current;
    if (!view || !lineNumber || lineNumber < 1) return;
    const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
    const anchor = Math.min(line.from + Math.max(character, 0), line.to);
    view.dispatch({
      selection: { anchor },
      effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
    });
  }, []);

  const revealDiagnostic = useCallback((diagnostic: WorkspaceDiagnostic): void => {
    const view = editorViewRef.current;
    if (!view) return;
    recordNavigationOrigin();
    const anchor = Math.min(diagnostic.from, view.state.doc.length);
    view.dispatch({
      selection: { anchor },
      effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
    });
    view.focus();
  }, [recordNavigationOrigin]);

  const createEditor = useCallback((
    tab: WorkspaceTab,
    lineNumber?: number | null,
    character?: number | null,
  ): void => {
    destroyEditor();
    const host = editorHostRef.current;
    if (!host || tab.file.fileKind !== 'text') return;
    const editorPath = tab.path;
    const language = languageSupport(tab.file.path);
    const diagnosticsMode = diagnosticMode(tab.file.path, language);
    const readGitLineBlame = workspace?.getGitLineBlame;
    const extensions: Extension[] = [
      workspaceEditorTheme,
      ...(readGitLineBlame ? [gitLineBlame({
        path: editorPath, lineEnding: tab.file.lineEnding,
        read: readGitLineBlame,
      })] : []),
      lineNumbers(),
      lintGutter(),
      workspaceEditorContentClip,
      workspaceEditorScrollbars,
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      syntaxHighlighting(workspaceEditorHighlightStyle),
      bracketMatching(),
      bracketPairGuides(),
      highlightActiveLine(),
      search({ top: true, createPanel: createEditorSearchBridgePanel }),
      keymap.of([
        { key: 'Mod-[', run: () => { void navigateHistory('back'); return true; } },
        { key: 'Mod-]', run: () => { void navigateHistory('forward'); return true; } },
        { key: 'Ctrl--', run: () => { void navigateHistory('back'); return true; } },
        { key: 'Ctrl-Shift--', run: () => { void navigateHistory('forward'); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
        { key: 'Mod-s', run: () => { void saveFileRef.current(); return true; } },
        { key: 'Mod-f', run: openEditorSearch },
        { key: 'Mod-h', run: openEditorSearch },
        { key: 'Mod-Alt-f', run: openEditorSearch },
        { key: 'Mod-w', run: () => { closeTabRef.current(editorPath); return true; } },
        ...Array.from({ length: 9 }, (_, index) => ({
          key: `Mod-${index + 1}`,
          run: () => {
            const next = tabsRef.current[index];
            if (next) activateOpenTab(next.path);
            return true;
          },
        })),
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        let signatureTrigger = false;
        let signatureClose = false;
        update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
          const text = inserted.toString();
          if (text.endsWith('(') || text.endsWith(',')) signatureTrigger = true;
          if (text.endsWith(')') || text.endsWith(';')) signatureClose = true;
        });
        if (signatureClose) {
          cancelSignatureHelp();
          queueMicrotask(() => {
            if (editorViewRef.current === update.view) {
              update.view.dispatch({ effects: setSignatureHelpTooltip.of(null) });
            }
          });
        } else if (signatureTrigger) {
          void requestLanguageServerSignatureHelp(
            update.view,
            editorPath,
            update.state.selection.main.head,
          );
        }
        cancelDiagnostics();
        updateTab(editorPath, (current) => ({
          ...current,
          draftContent: update.state.doc.toString(),
          editorState: update.state,
        }));
        scheduleEditorDiagnostics(update.view, editorPath, diagnosticsMode);
      }),
    ];
    const languageServerLanguage = languageServerLanguageForPath(editorPath);
    if (languageServerLanguage) {
      let hoverModifierPressed = false;
      let definitionLinkCandidate: DefinitionLinkRange | null = null;
      let definitionLinkRequestSequence = 0;
      const symbolHover = hoverTooltip(async (view, offset) => {
        const compact = hoverModifierPressed;
        const response = await requestLanguageServerHover(view, editorPath, offset);
        if (compact !== hoverModifierPressed || !response) return null;
        return languageServerHoverTooltip(view, offset, response, compact);
      }, { hideOnChange: true, hoverTime: 250 });
      const setDefinitionLink = (view: EditorView, range: DefinitionLinkRange | null): void => {
        const current = view.state.field(definitionLinkRangeField);
        if (current?.from === range?.from && current?.to === range?.to) return;
        view.dispatch({ effects: setDefinitionLinkRange.of(range) });
      };
      const clearDefinitionLink = (view: EditorView): void => {
        definitionLinkRequestSequence += 1;
        definitionLinkCandidate = null;
        setDefinitionLink(view, null);
      };
      const updateDefinitionLink = (event: MouseEvent, view: EditorView): void => {
        if (
          !definitionModifierPressed(event)
          || !isLanguageServerUsable(languageServerLanguage)
          || !(event.target instanceof Node)
          || !view.contentDOM.contains(event.target)
        ) {
          clearDefinitionLink(view);
          return;
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null) {
          clearDefinitionLink(view);
          return;
        }
        const word = view.state.wordAt(offset);
        if (!word) {
          clearDefinitionLink(view);
          return;
        }
        if (definitionLinkCandidate?.from === word.from && definitionLinkCandidate.to === word.to) return;
        definitionLinkCandidate = { from: word.from, to: word.to };
        const sequence = ++definitionLinkRequestSequence;
        setDefinitionLink(view, null);
        void resolveLanguageServerDefinitionLocations(view, editorPath, offset).then((locations) => {
          if (
            sequence !== definitionLinkRequestSequence
            || !hoverModifierPressed
            || editorViewRef.current !== view
            || editorPathRef.current !== editorPath
          ) return;
          setDefinitionLink(view, locations && locations.length > 0 ? definitionLinkCandidate : null);
        }).catch(() => {
          if (sequence === definitionLinkRequestSequence && editorViewRef.current === view) {
            setDefinitionLink(view, null);
          }
        });
      };
      const updateHoverModifier = (event: MouseEvent | KeyboardEvent, view: EditorView): void => {
        const pressed = definitionModifierPressed(event);
        if (pressed === hoverModifierPressed) return;
        hoverModifierPressed = pressed;
        view.dispatch({ effects: closeHoverTooltip(symbolHover) });
        if (!pressed) clearDefinitionLink(view);
      };
      const clearHoverModifier = (view: EditorView): void => {
        if (hoverModifierPressed) {
          hoverModifierPressed = false;
          view.dispatch({ effects: closeHoverTooltip(symbolHover) });
        }
        clearDefinitionLink(view);
      };
      extensions.push(
        autocompletion({
          activateOnTypingDelay: 180,
          override: [languageServerCompletionSource(editorPath)],
        }),
        symbolHover,
        definitionLinkRangeField,
        signatureHelpTooltipField,
        keymap.of([
          {
            key: 'Shift-F12',
            run: (view) => {
              void requestLanguageServerReferences(view, editorPath, view.state.selection.main.head);
              return true;
            },
          },
          {
            key: 'F2',
            run: (view) => {
              void requestLanguageServerRename(view, editorPath, view.state.selection.main.head);
              return true;
            },
          },
          {
            key: 'Mod-.',
            run: (view) => {
              void requestLanguageServerCodeActions(view, editorPath);
              return true;
            },
          },
          {
            key: 'Mod-Shift-Space',
            run: (view) => {
              void requestLanguageServerSignatureHelp(view, editorPath, view.state.selection.main.head);
              return true;
            },
          },
          {
            key: 'Escape',
            run: (view) => {
              const hasSignature = view.state.field(signatureHelpTooltipField, false) !== null;
              if (!assistStateRef.current && !hasSignature) return false;
              cancelSignatureHelp();
              view.dispatch({ effects: setSignatureHelpTooltip.of(null) });
              setAssistState(null);
              return true;
            },
          },
        ]),
        EditorView.domEventHandlers({
          mousemove: (event, view) => {
            updateHoverModifier(event, view);
            updateDefinitionLink(event, view);
          },
          mouseleave: (_event, view) => {
            clearDefinitionLink(view);
          },
          keydown: (event, view) => {
            updateHoverModifier(event, view);
          },
          keyup: (event, view) => {
            updateHoverModifier(event, view);
          },
          blur: (_event, view) => {
            clearHoverModifier(view);
          },
          mousedown: (event, view) => {
            if (
              event.button !== 0
              || !definitionModifierPressed(event)
              || !isLanguageServerUsable(languageServerLanguage)
            ) return false;
            const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (offset === null) return false;
            event.preventDefault();
            void requestLanguageServerDefinition(view, editorPath, offset);
            return true;
          },
        }),
      );
    }
    if (language) extensions.push(language);
    const state = tab.editorState ?? EditorState.create({ doc: tab.draftContent, extensions });
    const view = new EditorView({ state, parent: host });
    editorViewRef.current = view;
    editorPathRef.current = editorPath;
    syncEditorSearchPanel(view);
    scheduleEditorDiagnostics(view, editorPath, diagnosticsMode, 0);
    updateTab(tab.path, (current) => ({ ...current, editorState: view.state }));
    requestAnimationFrame(() => {
      revealLine(lineNumber, character ?? 0);
      view.focus();
    });
  }, [
    cancelDiagnostics,
    cancelSignatureHelp,
    destroyEditor,
    languageServerCompletionSource,
    isLanguageServerUsable,
    navigateHistory,
    openEditorSearch,
    requestLanguageServerCodeActions,
    requestLanguageServerDefinition,
    requestLanguageServerHover,
    requestLanguageServerReferences,
    requestLanguageServerRename,
    requestLanguageServerSignatureHelp,
    resolveLanguageServerDefinitionLocations,
    revealLine,
    scheduleEditorDiagnostics,
    activateOpenTab,
    syncEditorSearchPanel,
    updateTab,
  ]);

  const createSourceExcerptViewer = useCallback((
    tab: WorkspaceTab,
    lineNumber?: number | null,
    character?: number | null,
  ): void => {
    destroyEditor();
    const host = editorHostRef.current;
    const excerpt = tab.sourceExcerpt;
    if (!host || !excerpt) return;
    const language = languageSupport(tab.file.path);
    const extensions: Extension[] = [
      workspaceEditorTheme,
      lineNumbers({
        formatNumber: (line) => String(excerpt.startLine + line - 1),
      }),
      workspaceEditorContentClip,
      workspaceEditorScrollbars,
      highlightSpecialChars(),
      drawSelection(),
      syntaxHighlighting(workspaceEditorHighlightStyle),
      bracketPairGuides(),
      highlightActiveLine(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({
        'aria-label': `Read-only source excerpt for ${tab.path}`,
        'aria-readonly': 'true',
        tabindex: '0',
      }),
      keymap.of([
        { key: 'Mod-[', run: () => { void navigateHistory('back'); return true; } },
        { key: 'Mod-]', run: () => { void navigateHistory('forward'); return true; } },
        { key: 'Ctrl--', run: () => { void navigateHistory('back'); return true; } },
        { key: 'Ctrl-Shift--', run: () => { void navigateHistory('forward'); return true; } },
        { key: 'Mod-w', run: () => { closeTabRef.current(tab.path); return true; } },
        ...Array.from({ length: 9 }, (_, index) => ({
          key: `Mod-${index + 1}`,
          run: () => {
            const next = tabsRef.current[index];
            if (next) activateOpenTab(next.path);
            return true;
          },
        })),
      ]),
    ];
    if (language) extensions.push(language);
    const state = EditorState.create({ doc: excerpt.content, extensions });
    const view = new EditorView({ state, parent: host });
    editorViewRef.current = view;
    editorPathRef.current = null;
    const requestedLine = lineNumber ?? excerpt.targetLine;
    const localLine = Math.min(
      Math.max(requestedLine - excerpt.startLine + 1, 1),
      view.state.doc.lines,
    );
    requestAnimationFrame(() => {
      revealLine(localLine, character ?? 0);
      view.focus();
    });
  }, [activateOpenTab, destroyEditor, navigateHistory, revealLine]);


  return {
    closeTabRef,
    createEditor,
    createSourceExcerptViewer,
    destroyEditor,
    revealDiagnostic,
    revealLine,
    saveFileRef,
  };
}
