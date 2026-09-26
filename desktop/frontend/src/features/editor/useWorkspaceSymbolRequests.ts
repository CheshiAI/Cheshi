import { useCallback, useEffect, useMemo, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { cheshiDesktop as workspace, type LanguageServerLocation, type LanguageServerStatus } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import { languageServerLanguageForPath, normalizeLanguageServerDefinitionResult,
  normalizeLanguageServerSignatureHelpResult } from './languageServerDiagnostics';
import { assertLanguageServerValue, canUseLanguageServer, languageServerPositionAt,
  languageServerSignatureTooltip, setSignatureHelpTooltip } from './workspaceEditorModel';
import { beginWorkspaceEditorRequest, createWorkspaceRequestTracker,
  type WorkspaceEditorRequest } from './workspaceEditorRequest';

interface Options {
  api?: Pick<NonNullable<typeof workspace>, 'getLanguageServerDefinitions' | 'getLanguageServerSignatureHelp'>;
  editorViewRef: RefObject<EditorView | null>;
  editorPathRef: RefObject<string | null>;
  languageServersRef: RefObject<LanguageServerStatus[]>;
  nextLanguageServerDocumentVersion: (path: string) => number;
  loadFileRef: RefObject<(path: string, line?: number | null, forceReload?: boolean, character?: number | null) => Promise<void>>;
  recordNavigationOrigin: () => void;
  setErrorMessage: (message: string) => void;
}

export function useWorkspaceSymbolRequests({ api = workspace, editorViewRef, editorPathRef,
  languageServersRef, nextLanguageServerDocumentVersion, loadFileRef, recordNavigationOrigin,
  setErrorMessage }: Options) {
  // Hovering a definition link must not supersede an explicit navigation request.
  const navigationRequests = useMemo(createWorkspaceRequestTracker, []);
  const linkRequests = useMemo(createWorkspaceRequestTracker, []);
  const signatureRequests = useMemo(createWorkspaceRequestTracker, []);

  const loadDefinitions = useCallback(async (view: EditorView, path: string, offset: number,
    request: WorkspaceEditorRequest): Promise<LanguageServerLocation[] | null> => {
    const language = languageServerLanguageForPath(path);
    if (!language || !api?.getLanguageServerDefinitions
      || !canUseLanguageServer(language, languageServersRef.current)) return null;
    const response = normalizeLanguageServerDefinitionResult(await api.getLanguageServerDefinitions({
      language, path, content: view.state.doc.toString(),
      version: nextLanguageServerDocumentVersion(path), position: languageServerPositionAt(view, offset),
    }));
    if (!request.isCurrent()) return null;
    assertLanguageServerValue(response, 'Cheshi returned an invalid language server definition response.');
    return response.locations;
  }, [api, nextLanguageServerDocumentVersion]);

  const resolveLanguageServerDefinitionLocations = useCallback((view: EditorView, path: string, offset: number) => {
    const request = beginWorkspaceEditorRequest(linkRequests, view, path, editorViewRef, editorPathRef);
    return loadDefinitions(view, path, offset, request);
  }, [linkRequests, loadDefinitions]);

  const requestLanguageServerDefinition = useCallback(async (view: EditorView, path: string, offset: number) => {
    const request = beginWorkspaceEditorRequest(navigationRequests, view, path, editorViewRef, editorPathRef);
    try {
      const locations = await loadDefinitions(view, path, offset, request);
      const location = locations?.[0];
      if (!request.isCurrent() || !location) return;
      recordNavigationOrigin();
      await loadFileRef.current(location.path, location.range.start.line + 1, false, location.range.start.character);
    } catch (error) {
      if (request.isCurrent()) setErrorMessage(errorMessage(error));
    }
  }, [navigationRequests, loadDefinitions, recordNavigationOrigin]);

  const requestLanguageServerSignatureHelp = useCallback(async (view: EditorView, path: string, offset: number) => {
    const request = beginWorkspaceEditorRequest(signatureRequests, view, path, editorViewRef, editorPathRef);
    const selection = view.state.selection;
    const isCurrent = () => request.isCurrent() && view.state.selection.eq(selection);
    const language = languageServerLanguageForPath(path);
    if (!language || !api?.getLanguageServerSignatureHelp
      || !canUseLanguageServer(language, languageServersRef.current)) return;
    try {
      const response = normalizeLanguageServerSignatureHelpResult(await api.getLanguageServerSignatureHelp({
        language, path, content: view.state.doc.toString(),
        version: nextLanguageServerDocumentVersion(path), position: languageServerPositionAt(view, offset),
      }));
      if (!isCurrent()) return;
      view.dispatch({ effects: setSignatureHelpTooltip.of(response ? languageServerSignatureTooltip(view, response) : null) });
    } catch {
      if (isCurrent()) view.dispatch({ effects: setSignatureHelpTooltip.of(null) });
    }
  }, [api, signatureRequests, nextLanguageServerDocumentVersion]);

  const cancelSignatureHelp = useCallback(() => signatureRequests.invalidate(), [signatureRequests]);
  const resetSymbolRequests = useCallback(() => {
    navigationRequests.invalidate();
    linkRequests.invalidate();
    signatureRequests.invalidate();
  }, [navigationRequests, linkRequests, signatureRequests]);
  useEffect(() => resetSymbolRequests, [resetSymbolRequests]);

  return { requestLanguageServerDefinition, resolveLanguageServerDefinitionLocations,
    requestLanguageServerSignatureHelp, cancelSignatureHelp, resetSymbolRequests };
}
