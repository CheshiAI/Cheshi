import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { EditorView } from '@codemirror/view';
import { cheshiDesktop as workspace, type LanguageServerDiagnostic, type LanguageServerLocation,
  type LanguageServerPosition, type LanguageServerStatus } from '../../cheshiDesktop';
import { errorMessage as toErrorMessage } from '../../shared/errorMessage';
import { languageServerLanguageForPath, normalizeLanguageServerReferenceResult,
  normalizeLanguageServerPrepareRenameResult, normalizeLanguageServerCodeActionResult } from './languageServerDiagnostics';
import { assertLanguageServerValue, canUseLanguageServer, editorOffsetAt, languageServerPositionAt,
  languageServerSelectionRange, rangeContainsPosition, REFERENCE_PREVIEW_CONTEXT_LINES } from './workspaceEditorModel';
import type { WorkspaceDiagnostic } from './workspaceDiagnostics';
import type { ReferenceSourcePreview, WorkspaceEditorAssistState } from './workspaceEditorAssistState';
import { requestWorkspaceCodeActions } from './workspaceCodeActionRequest';
import { beginWorkspaceEditorRequest, type WorkspaceEditorRequest, type WorkspaceRequestTracker } from './workspaceEditorRequest';

export interface PendingWorkspaceRename {
  path: string;
  position: LanguageServerPosition;
  request: WorkspaceEditorRequest;
}

export interface WorkspaceAssistRequestOptions {
  editorPathRef: RefObject<string | null>;
  editorViewRef: RefObject<EditorView | null>;
  pendingRenameRef: RefObject<PendingWorkspaceRename | null>;
  assistRequests: WorkspaceRequestTracker;
  referencePreviewRequestSequence: RefObject<number>;
  setAssistState: Dispatch<SetStateAction<WorkspaceEditorAssistState | null>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
}

interface Options extends WorkspaceAssistRequestOptions {
  api?: Pick<NonNullable<typeof workspace>, 'getLanguageServerReferences' | 'prepareLanguageServerRename' | 'getLanguageServerCodeActions' | 'readWorkspaceFileExcerpt'>;
  languageServersRef: RefObject<LanguageServerStatus[]>;
  languageServerDiagnosticsRef: RefObject<Map<string, LanguageServerDiagnostic[]>>;
  workspaceDiagnosticsRef: RefObject<WorkspaceDiagnostic[]>;
  nextLanguageServerDocumentVersion: (path: string) => number;
}

export function useWorkspaceAssistRequests({ editorPathRef, editorViewRef, pendingRenameRef, assistRequests,
  referencePreviewRequestSequence, setAssistState, setErrorMessage, languageServersRef,
  languageServerDiagnosticsRef, workspaceDiagnosticsRef, nextLanguageServerDocumentVersion, api = workspace }: Options) {
  useEffect(() => () => {
    assistRequests.invalidate();
    referencePreviewRequestSequence.current += 1;
  }, [assistRequests, referencePreviewRequestSequence]);

  const referenceRequestRef = useRef<WorkspaceEditorRequest | null>(null);
  const beginRequest = useCallback((view: EditorView, path: string) => {
    referencePreviewRequestSequence.current += 1;
    pendingRenameRef.current = null;
    setAssistState(null);
    return beginWorkspaceEditorRequest(assistRequests, view, path, editorViewRef, editorPathRef);
  }, [assistRequests]);

  const loadReferencePreview = useCallback(async (
    location: LanguageServerLocation,
    selectedIndex: number,
  ): Promise<void> => {
    const parent = referenceRequestRef.current;
    if (!parent?.isCurrent()) return;
    const sequence = ++referencePreviewRequestSequence.current;
    setAssistState((current) => current?.kind === 'references'
      ? { ...current, selectedIndex, preview: null, previewLoading: true }
      : current);
    try {
      const excerpt = await api?.readWorkspaceFileExcerpt?.({
        path: location.path,
        line: location.range.start.line + 1,
        contextLines: REFERENCE_PREVIEW_CONTEXT_LINES,
      });
      if (!parent.isCurrent() || sequence !== referencePreviewRequestSequence.current || !excerpt) return;
      const preview: ReferenceSourcePreview = {
        content: excerpt.content,
        startLine: excerpt.startLine,
        targetLine: location.range.start.line + 1,
      };
      setAssistState((current) => current?.kind === 'references' && current.selectedIndex === selectedIndex
        ? { ...current, preview, previewLoading: false }
        : current);
    } catch {
      if (!parent.isCurrent() || sequence !== referencePreviewRequestSequence.current) return;
      setAssistState((current) => current?.kind === 'references' && current.selectedIndex === selectedIndex
        ? { ...current, preview: null, previewLoading: false }
        : current);
    }
  }, [api]);

  const requestLanguageServerReferences = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<void> => {
    const language = languageServerLanguageForPath(editorPath);
    const getReferences = api?.getLanguageServerReferences;
    if (
      !language
      || !getReferences
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return;
    const request = beginRequest(view, editorPath);
    setErrorMessage('');
    try {
      const response = normalizeLanguageServerReferenceResult(await getReferences({
        language,
        path: editorPath,
        content: view.state.doc.toString(),
        version: nextLanguageServerDocumentVersion(editorPath),
        position: languageServerPositionAt(view, offset),
      }));
      assertLanguageServerValue(response, 'Cheshi returned an invalid language server reference response.');
      if (!request.isCurrent()) return;
      referenceRequestRef.current = request;
      setAssistState({
        kind: 'references',
        locations: response.locations,
        selectedIndex: 0,
        preview: null,
        previewLoading: response.locations.length > 0,
      });
      const first = response.locations[0];
      if (first) void loadReferencePreview(first, 0);
    } catch (error) {
      if (request.isCurrent()) setErrorMessage(toErrorMessage(error));
    }
  }, [api, beginRequest, loadReferencePreview, nextLanguageServerDocumentVersion]);

  const requestLanguageServerRename = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<void> => {
    const language = languageServerLanguageForPath(editorPath);
    const prepareRename = api?.prepareLanguageServerRename;
    if (
      !language
      || !prepareRename
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return;
    const request = beginRequest(view, editorPath);
    setErrorMessage('');
    try {
      const position = languageServerPositionAt(view, offset);
      const response = normalizeLanguageServerPrepareRenameResult(await prepareRename({
        language,
        path: editorPath,
        content: view.state.doc.toString(),
        version: nextLanguageServerDocumentVersion(editorPath),
        position,
      }));
      assertLanguageServerValue(response, 'Cheshi returned an invalid language server rename response.');
      if (!request.isCurrent()) return;
      if (!response.available) return;
      const fallbackWord = view.state.wordAt(offset);
      const from = response.range ? editorOffsetAt(view, response.range.start) : fallbackWord?.from ?? offset;
      const to = response.range ? editorOffsetAt(view, response.range.end) : fallbackWord?.to ?? offset;
      const placeholder = response.placeholder ?? view.state.sliceDoc(from, to);
      if (!placeholder) return;
      pendingRenameRef.current = { path: editorPath, position, request };
      setAssistState({ kind: 'rename', value: placeholder, placeholder, submitting: false });
    } catch (error) {
      if (request.isCurrent()) setErrorMessage(toErrorMessage(error));
    }
  }, [api, beginRequest, nextLanguageServerDocumentVersion]);

  const requestLanguageServerCodeActions = useCallback(async (
    view: EditorView,
    editorPath: string,
  ): Promise<void> => {
    const language = languageServerLanguageForPath(editorPath);
    const getCodeActions = api?.getLanguageServerCodeActions;
    if (
      !language
      || !getCodeActions
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return;
    setErrorMessage('');
    const request = beginRequest(view, editorPath);
    await requestWorkspaceCodeActions({
      setAssistState,
      isCurrent: request.isCurrent,
      load: async () => {
        const offset = view.state.selection.main.head;
        const position = languageServerPositionAt(view, offset);
        const availableDiagnostics = languageServerDiagnosticsRef.current.get(editorPath) ?? [];
        const languageServerDiagnostics = availableDiagnostics.filter((diagnostic) => (
          rangeContainsPosition(diagnostic.range, position)
        )).map((diagnostic) => ({
          ...diagnostic,
          ...(typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
            ? { code: diagnostic.code }
            : { code: undefined }),
        }));
        const requestDiagnostics = languageServerDiagnostics.length > 0
          ? languageServerDiagnostics
          : workspaceDiagnosticsRef.current
            .filter((diagnostic) => diagnostic.from <= offset && offset <= diagnostic.to)
            .map((diagnostic): LanguageServerDiagnostic => ({
              range: {
                start: languageServerPositionAt(view, diagnostic.from),
                end: languageServerPositionAt(view, diagnostic.to),
              },
              message: diagnostic.message,
              severity: diagnostic.severity === 'error' ? 1 : diagnostic.severity === 'warning' ? 2 : 3,
              ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
              ...(diagnostic.source ? { source: diagnostic.source } : {}),
            }));
        const response = normalizeLanguageServerCodeActionResult(await getCodeActions({
          language,
          path: editorPath,
          content: view.state.doc.toString(),
          version: nextLanguageServerDocumentVersion(editorPath),
          range: requestDiagnostics[0]?.range ?? languageServerSelectionRange(view),
          diagnostics: requestDiagnostics,
        }));
        assertLanguageServerValue(response, 'Cheshi returned an invalid language server code action response.');
        return response.actions;
      },
    });
  }, [api, beginRequest, nextLanguageServerDocumentVersion]);

  return { loadReferencePreview, requestLanguageServerReferences, requestLanguageServerRename, requestLanguageServerCodeActions };
}
