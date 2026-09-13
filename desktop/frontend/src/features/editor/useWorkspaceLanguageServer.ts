import {
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { setDiagnostics as setCodeMirrorDiagnostics } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import { errorMessage as toErrorMessage } from '../../shared/errorMessage';
import {
  cheshiDesktop as workspace,
  type LanguageServerDiagnostic,
  type LanguageServerHoverResult,
  type LanguageServerLanguage,
  type LanguageServerLocation,
  type LanguageServerMode,
  type LanguageServerPosition,
  type LanguageServerStatus,
} from '../../cheshiDesktop';
import {
  languageServerLanguageForPath,
  normalizeLanguageServerCompletionResult,
  normalizeLanguageServerCodeActionResult,
  normalizeLanguageServerDefinitionResult,
  normalizeLanguageServerDiagnostic,
  normalizeLanguageServerDiagnosticsEvent,
  normalizeLanguageServerHoverResult,
  normalizeLanguageServerPrepareRenameResult,
  normalizeLanguageServerReferenceResult,
  normalizeLanguageServerSelectionResult,
  normalizeLanguageServerSignatureHelpResult,
  normalizeLanguageServerStatuses,
  normalizeLanguageServerUpdateResult,
  workspaceDiagnosticsFromLanguageServer,
} from './languageServerDiagnostics';
import type {
  ReferenceSourcePreview,
  WorkspaceEditorAssistState,
} from './WorkspaceEditorAssistPanel';
import { requestWorkspaceCodeActions } from './workspaceCodeActionRequest';
import {
  collectParserDiagnostics,
  toCodeMirrorDiagnostics,
  type WorkspaceDiagnostic,
  type WorkspaceDiagnosticsStatus,
  type WorkspaceDiagnosticsWorkerResponse,
} from './workspaceDiagnostics';
import {
  assertLanguageServerValue,
  canUseLanguageServer,
  codeMirrorCompletion,
  diagnosticMode,
  editorOffsetAt,
  languageServerPositionAt,
  languageServerSelectionRange,
  languageServerSignatureTooltip,
  languageSupport,
  LANGUAGE_SERVER_FALLBACK_DELAY_MS,
  rangeContainsPosition,
  REFERENCE_PREVIEW_CONTEXT_LINES,
  setSignatureHelpTooltip,
  type LanguageServerExpectation,
  type WorkspaceDiagnosticMode,
} from './workspaceEditorModel';

interface UseWorkspaceLanguageServerOptions {
  activeLanguageServerLanguage: LanguageServerLanguage | null;
  editorPathRef: RefObject<string | null>;
  editorViewRef: RefObject<EditorView | null>;
  loadFileRef: RefObject<(
    relativePath: string,
    lineNumber?: number | null,
    forceReload?: boolean,
    character?: number | null,
  ) => Promise<void>>;
  pendingRenameRef: RefObject<{
    path: string;
    position: LanguageServerPosition;
  } | null>;
  recordNavigationOrigin: () => void;
  referencePreviewRequestSequence: RefObject<number>;
  setAssistState: Dispatch<SetStateAction<WorkspaceEditorAssistState | null>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
}

export function useWorkspaceLanguageServer({
  activeLanguageServerLanguage,
  editorPathRef,
  editorViewRef,
  loadFileRef,
  pendingRenameRef,
  recordNavigationOrigin,
  referencePreviewRequestSequence,
  setAssistState,
  setErrorMessage,
}: UseWorkspaceLanguageServerOptions) {
  const [diagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnostic[]>([]);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<WorkspaceDiagnosticsStatus>('ready');
  const [languageServers, setLanguageServers] = useState<LanguageServerStatus[]>([]);
  const [languageServerConfiguring, setLanguageServerConfiguring] = useState(false);
  const diagnosticsPathRef = useRef<string | null>(null);
  const diagnosticsTimerRef = useRef<number | null>(null);
  const languageServerFallbackTimerRef = useRef<number | null>(null);
  const diagnosticsWorkerRef = useRef<Worker | null>(null);
  const diagnosticsRequestSequence = useRef(0);
  const signatureHelpRequestSequence = useRef(0);
  const languageServerDocumentVersionsRef = useRef(new Map<string, number>());
  const languageServerDiagnosticsRef = useRef(new Map<string, LanguageServerDiagnostic[]>());
  const workspaceDiagnosticsRef = useRef(diagnostics);
  const languageServerExpectationRef = useRef<LanguageServerExpectation | null>(null);
  const languageServersRef = useRef(languageServers);
  languageServersRef.current = languageServers;
  workspaceDiagnosticsRef.current = diagnostics;

  const replaceLanguageServerStatus = useCallback((nextStatus: LanguageServerStatus): void => {
    setLanguageServers((current) => {
      const next = current.some((status) => status.language === nextStatus.language)
        ? current.map((status) => status.language === nextStatus.language ? nextStatus : status)
        : [...current, nextStatus];
      languageServersRef.current = next;
      return next;
    });
  }, []);

  const nextLanguageServerDocumentVersion = useCallback((path: string): number => {
    const version = (languageServerDocumentVersionsRef.current.get(path) ?? 0) + 1;
    languageServerDocumentVersionsRef.current.set(path, version);
    return version;
  }, []);

  const applyDiagnostics = useCallback((
    view: EditorView,
    path: string,
    nextDiagnostics: WorkspaceDiagnostic[],
    status: WorkspaceDiagnosticsStatus = 'ready',
  ): void => {
    if (editorViewRef.current !== view || editorPathRef.current !== path) return;
    diagnosticsPathRef.current = path;
    setWorkspaceDiagnostics(nextDiagnostics);
    setDiagnosticsStatus(status);
    view.dispatch(setCodeMirrorDiagnostics(view.state, toCodeMirrorDiagnostics(nextDiagnostics)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!workspace?.getLanguageServers) return undefined;
    void workspace.getLanguageServers().then((value) => {
      if (cancelled) return;
      const statuses = normalizeLanguageServerStatuses(value);
      if (!statuses) return;
      languageServersRef.current = statuses;
      setLanguageServers(statuses);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => workspace?.onLanguageServerDiagnostics?.((value) => {
    const event = normalizeLanguageServerDiagnosticsEvent(value);
    const expectation = languageServerExpectationRef.current;
    if (!event || !expectation) return;
    if (event.language !== expectation.language || event.path !== expectation.path) return;
    if (event.version !== null && event.version < expectation.version) return;
    if (diagnosticsRequestSequence.current !== expectation.requestId) return;
    const view = editorViewRef.current;
    if (!view || editorPathRef.current !== event.path) return;
    expectation.diagnosticsApplied = true;
    if (languageServerFallbackTimerRef.current !== null) {
      window.clearTimeout(languageServerFallbackTimerRef.current);
      languageServerFallbackTimerRef.current = null;
    }
    const status = languageServersRef.current.find((entry) => entry.language === event.language);
    const serverName = status?.serverName ?? event.language;
    const normalizedDiagnostics = event.diagnostics
      .map(normalizeLanguageServerDiagnostic)
      .filter((diagnostic): diagnostic is LanguageServerDiagnostic => diagnostic !== null);
    languageServerDiagnosticsRef.current.set(event.path, normalizedDiagnostics);
    if (status && status.state !== 'running') {
      replaceLanguageServerStatus({
        ...status,
        state: 'running',
        message: `${status.serverName} is running.`,
      });
    }
    applyDiagnostics(
      view,
      event.path,
      workspaceDiagnosticsFromLanguageServer(event.diagnostics, view.state.doc.toString(), serverName),
    );
  }), [applyDiagnostics, replaceLanguageServerStatus]);

  const ensureDiagnosticsWorker = useCallback((): Worker => {
    const current = diagnosticsWorkerRef.current;
    if (current) return current;
    const worker = new Worker(new URL('./workspaceDiagnostics.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkspaceDiagnosticsWorkerResponse>): void => {
      const response = event.data;
      if (response.requestId !== diagnosticsRequestSequence.current) return;
      const expectation = languageServerExpectationRef.current;
      if (expectation?.requestId === response.requestId && expectation.diagnosticsApplied) return;
      const view = editorViewRef.current;
      if (!view || editorPathRef.current !== response.path) return;
      if ('error' in response) {
        applyDiagnostics(view, response.path, [], 'error');
        return;
      }
      applyDiagnostics(view, response.path, response.diagnostics);
    };
    worker.onerror = (): void => {
      const expectation = languageServerExpectationRef.current;
      if (expectation?.requestId === diagnosticsRequestSequence.current && expectation.diagnosticsApplied) return;
      const view = editorViewRef.current;
      const path = editorPathRef.current;
      if (view && path) applyDiagnostics(view, path, [], 'error');
    };
    diagnosticsWorkerRef.current = worker;
    return worker;
  }, [applyDiagnostics]);

  const runLocalEditorDiagnostics = useCallback((
    view: EditorView,
    path: string,
    mode: WorkspaceDiagnosticMode,
    requestId: number,
    pathChanged: boolean,
  ): void => {
    if (editorViewRef.current !== view || editorPathRef.current !== path) return;
    if (mode === 'unsupported') {
      applyDiagnostics(view, path, [], 'unsupported');
      return;
    }
    if (mode === 'parser') {
      applyDiagnostics(view, path, collectParserDiagnostics(view.state));
      return;
    }
    if (pathChanged) {
      setWorkspaceDiagnostics([]);
      view.dispatch(setCodeMirrorDiagnostics(view.state, []));
    }
    setDiagnosticsStatus('checking');
    ensureDiagnosticsWorker().postMessage({
      requestId,
      path,
      content: view.state.doc.toString(),
      engine: mode,
    });
  }, [applyDiagnostics, ensureDiagnosticsWorker]);

  const runEditorDiagnostics = useCallback((
    view: EditorView,
    path: string,
    mode: WorkspaceDiagnosticMode,
  ): void => {
    if (editorViewRef.current !== view || editorPathRef.current !== path) return;
    const pathChanged = diagnosticsPathRef.current !== path;
    const requestId = ++diagnosticsRequestSequence.current;
    diagnosticsPathRef.current = path;
    if (languageServerFallbackTimerRef.current !== null) {
      window.clearTimeout(languageServerFallbackTimerRef.current);
      languageServerFallbackTimerRef.current = null;
    }

    const language = languageServerLanguageForPath(path);
    const serverStatus = language
      ? languageServersRef.current.find((status) => status.language === language)
      : null;
    const serverUnavailable = serverStatus?.mode === 'disabled'
      || serverStatus?.state === 'error'
      || (serverStatus?.mode === 'custom' && serverStatus.state === 'missing');
    if (!language || !workspace?.updateLanguageServerDocument || serverUnavailable) {
      languageServerExpectationRef.current = null;
      languageServerDiagnosticsRef.current.delete(path);
      runLocalEditorDiagnostics(view, path, mode, requestId, pathChanged);
      return;
    }

    const version = nextLanguageServerDocumentVersion(path);
    const expectation: LanguageServerExpectation = {
      language,
      path,
      requestId,
      version,
      diagnosticsApplied: false,
    };
    languageServerExpectationRef.current = expectation;
    if (pathChanged) {
      setWorkspaceDiagnostics([]);
      view.dispatch(setCodeMirrorDiagnostics(view.state, []));
    }
    setDiagnosticsStatus('checking');
    languageServerFallbackTimerRef.current = window.setTimeout(() => {
      languageServerFallbackTimerRef.current = null;
      if (
        languageServerExpectationRef.current !== expectation
        || expectation.diagnosticsApplied
        || diagnosticsRequestSequence.current !== requestId
      ) return;
      runLocalEditorDiagnostics(view, path, mode, requestId, pathChanged);
    }, LANGUAGE_SERVER_FALLBACK_DELAY_MS);

    void workspace.updateLanguageServerDocument({
      language,
      path,
      content: view.state.doc.toString(),
      version,
    }).then((value) => {
      if (languageServerExpectationRef.current !== expectation || diagnosticsRequestSequence.current !== requestId) return;
      const result = normalizeLanguageServerUpdateResult(value);
      assertLanguageServerValue(result, 'Cheshi returned an invalid language server response.');
      replaceLanguageServerStatus(result.status);
      expectation.version = result.version;
      if (result.active) return;
      if (languageServerFallbackTimerRef.current !== null) {
        window.clearTimeout(languageServerFallbackTimerRef.current);
        languageServerFallbackTimerRef.current = null;
      }
      languageServerExpectationRef.current = null;
      runLocalEditorDiagnostics(view, path, mode, requestId, pathChanged);
    }).catch(() => {
      if (languageServerExpectationRef.current !== expectation || diagnosticsRequestSequence.current !== requestId) return;
      if (languageServerFallbackTimerRef.current !== null) {
        window.clearTimeout(languageServerFallbackTimerRef.current);
        languageServerFallbackTimerRef.current = null;
      }
      languageServerExpectationRef.current = null;
      runLocalEditorDiagnostics(view, path, mode, requestId, pathChanged);
    });
  }, [nextLanguageServerDocumentVersion, replaceLanguageServerStatus, runLocalEditorDiagnostics]);

  const scheduleEditorDiagnostics = useCallback((
    view: EditorView,
    path: string,
    mode: WorkspaceDiagnosticMode,
    delay = 300,
  ): void => {
    if (diagnosticsTimerRef.current !== null) {
      window.clearTimeout(diagnosticsTimerRef.current);
    }
    diagnosticsTimerRef.current = window.setTimeout(() => {
      diagnosticsTimerRef.current = null;
      runEditorDiagnostics(view, path, mode);
    }, delay);
  }, [runEditorDiagnostics]);

  const configureActiveLanguageServer = useCallback(async (mode: LanguageServerMode): Promise<void> => {
    const language = activeLanguageServerLanguage;
    if (!language) return;
    setLanguageServerConfiguring(true);
    setErrorMessage('');
    try {
      let statuses: LanguageServerStatus[] | null;
      if (mode === 'custom') {
        const selectExecutable = workspace?.selectLanguageServerExecutable;
        assertLanguageServerValue(
          selectExecutable,
          'The language server executable picker is unavailable.',
        );
        const result = normalizeLanguageServerSelectionResult(
          await selectExecutable(language),
        );
        assertLanguageServerValue(
          result,
          'Cheshi returned an invalid language server selection response.',
        );
        if (result.canceled) return;
        statuses = result.statuses;
      } else {
        const configureLanguageServer = workspace?.configureLanguageServer;
        assertLanguageServerValue(
          configureLanguageServer,
          'The language server configuration API is unavailable.',
        );
        statuses = normalizeLanguageServerStatuses(
          await configureLanguageServer({ language, mode }),
        );
        assertLanguageServerValue(
          statuses,
          'Cheshi returned an invalid language server configuration response.',
        );
      }
      languageServersRef.current = statuses;
      setLanguageServers(statuses);
      const view = editorViewRef.current;
      const editorPath = editorPathRef.current;
      if (view && editorPath && languageServerLanguageForPath(editorPath) === language) {
        scheduleEditorDiagnostics(view, editorPath, diagnosticMode(editorPath, languageSupport(editorPath)), 0);
      }
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setLanguageServerConfiguring(false);
    }
  }, [activeLanguageServerLanguage, scheduleEditorDiagnostics]);

  const languageServerCompletionSource = useCallback((editorPath: string) => (
    async (context: CompletionContext): Promise<CompletionResult | null> => {
      const language = languageServerLanguageForPath(editorPath);
      const getCompletions = workspace?.getLanguageServerCompletions;
      const view = context.view;
      if (
        !language
        || !getCompletions
        || !view
        || !canUseLanguageServer(language, languageServersRef.current)
      ) return null;

      const token = context.matchBefore(/[\w$]*/);
      const previousCharacter = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
      if (!context.explicit && (!token || (token.from === token.to && !'.:>'.includes(previousCharacter)))) {
        return null;
      }

      let aborted = false;
      context.addEventListener('abort', () => {
        aborted = true;
      }, { onDocChange: true });
      try {
        const response = normalizeLanguageServerCompletionResult(await getCompletions({
          language,
          path: editorPath,
          content: context.state.doc.toString(),
          version: nextLanguageServerDocumentVersion(editorPath),
          position: languageServerPositionAt(view, context.pos),
        }));
        if (aborted) return null;
        assertLanguageServerValue(response, 'Cheshi returned an invalid language server completion response.');

        const firstEditRange = response.items[0]?.textEdit?.range;
        const sharedEditRange = firstEditRange && response.items.every((item) => (
          item.textEdit?.range.start.line === firstEditRange.start.line
          && item.textEdit.range.start.character === firstEditRange.start.character
          && item.textEdit.range.end.line === firstEditRange.end.line
          && item.textEdit.range.end.character === firstEditRange.end.character
        ));
        const requestedFrom = sharedEditRange
          ? editorOffsetAt(view, firstEditRange.start)
          : token?.from ?? context.pos;
        const from = requestedFrom <= context.pos ? requestedFrom : token?.from ?? context.pos;
        const requestedTo = sharedEditRange ? editorOffsetAt(view, firstEditRange.end) : context.pos;
        const to = requestedTo >= from ? requestedTo : context.pos;
        return {
          from,
          to,
          options: response.items.map(codeMirrorCompletion),
          ...(response.isIncomplete ? {} : { validFor: /^[\w$]*$/ }),
        };
      } catch {
        return null;
      }
    }
  ), [nextLanguageServerDocumentVersion]);

  const loadReferencePreview = useCallback(async (
    location: LanguageServerLocation,
    selectedIndex: number,
  ): Promise<void> => {
    const sequence = ++referencePreviewRequestSequence.current;
    setAssistState((current) => current?.kind === 'references'
      ? { ...current, selectedIndex, preview: null, previewLoading: true }
      : current);
    try {
      const excerpt = await workspace?.readWorkspaceFileExcerpt?.({
        path: location.path,
        line: location.range.start.line + 1,
        contextLines: REFERENCE_PREVIEW_CONTEXT_LINES,
      });
      if (sequence !== referencePreviewRequestSequence.current || !excerpt) return;
      const preview: ReferenceSourcePreview = {
        content: excerpt.content,
        startLine: excerpt.startLine,
        targetLine: location.range.start.line + 1,
      };
      setAssistState((current) => current?.kind === 'references' && current.selectedIndex === selectedIndex
        ? { ...current, preview, previewLoading: false }
        : current);
    } catch {
      if (sequence !== referencePreviewRequestSequence.current) return;
      setAssistState((current) => current?.kind === 'references' && current.selectedIndex === selectedIndex
        ? { ...current, preview: null, previewLoading: false }
        : current);
    }
  }, []);

  const requestLanguageServerReferences = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<void> => {
    const language = languageServerLanguageForPath(editorPath);
    const getReferences = workspace?.getLanguageServerReferences;
    if (
      !language
      || !getReferences
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return;
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
      if (editorViewRef.current !== view || editorPathRef.current !== editorPath) return;
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
      setErrorMessage(toErrorMessage(error));
    }
  }, [loadReferencePreview, nextLanguageServerDocumentVersion]);

  const requestLanguageServerSignatureHelp = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<void> => {
    const language = languageServerLanguageForPath(editorPath);
    const getSignatureHelp = workspace?.getLanguageServerSignatureHelp;
    if (
      !language
      || !getSignatureHelp
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return;
    const sequence = ++signatureHelpRequestSequence.current;
    try {
      const response = normalizeLanguageServerSignatureHelpResult(await getSignatureHelp({
        language,
        path: editorPath,
        content: view.state.doc.toString(),
        version: nextLanguageServerDocumentVersion(editorPath),
        position: languageServerPositionAt(view, offset),
      }));
      if (
        sequence !== signatureHelpRequestSequence.current
        || editorViewRef.current !== view
        || editorPathRef.current !== editorPath
      ) return;
      const tooltip = response ? languageServerSignatureTooltip(view, response) : null;
      view.dispatch({ effects: setSignatureHelpTooltip.of(tooltip) });
    } catch {
      if (sequence === signatureHelpRequestSequence.current && editorViewRef.current === view) {
        view.dispatch({ effects: setSignatureHelpTooltip.of(null) });
      }
    }
  }, [nextLanguageServerDocumentVersion]);

  const requestLanguageServerRename = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<void> => {
    const language = languageServerLanguageForPath(editorPath);
    const prepareRename = workspace?.prepareLanguageServerRename;
    if (
      !language
      || !prepareRename
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return;
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
      if (editorViewRef.current !== view || editorPathRef.current !== editorPath) return;
      if (!response.available) return;
      const fallbackWord = view.state.wordAt(offset);
      const from = response.range ? editorOffsetAt(view, response.range.start) : fallbackWord?.from ?? offset;
      const to = response.range ? editorOffsetAt(view, response.range.end) : fallbackWord?.to ?? offset;
      const placeholder = response.placeholder ?? view.state.sliceDoc(from, to);
      if (!placeholder) return;
      pendingRenameRef.current = { path: editorPath, position };
      setAssistState({ kind: 'rename', value: placeholder, placeholder, submitting: false });
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [nextLanguageServerDocumentVersion]);

  const requestLanguageServerCodeActions = useCallback(async (
    view: EditorView,
    editorPath: string,
  ): Promise<void> => {
    const language = languageServerLanguageForPath(editorPath);
    const getCodeActions = workspace?.getLanguageServerCodeActions;
    if (
      !language
      || !getCodeActions
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return;
    setErrorMessage('');
    const requestedDocument = view.state.doc;
    await requestWorkspaceCodeActions({
      setAssistState,
      isCurrent: () => editorViewRef.current === view
        && editorPathRef.current === editorPath
        && view.state.doc === requestedDocument,
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
  }, [nextLanguageServerDocumentVersion]);

  const resolveLanguageServerDefinitionLocations = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<LanguageServerLocation[] | null> => {
    const language = languageServerLanguageForPath(editorPath);
    const getDefinitions = workspace?.getLanguageServerDefinitions;
    if (
      !language
      || !getDefinitions
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return null;
    const response = normalizeLanguageServerDefinitionResult(await getDefinitions({
      language,
      path: editorPath,
      content: view.state.doc.toString(),
      version: nextLanguageServerDocumentVersion(editorPath),
      position: languageServerPositionAt(view, offset),
    }));
    assertLanguageServerValue(response, 'Cheshi returned an invalid language server definition response.');
    if (editorViewRef.current !== view || editorPathRef.current !== editorPath) return null;
    return response.locations;
  }, [nextLanguageServerDocumentVersion]);

  const requestLanguageServerDefinition = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<void> => {
    try {
      const locations = await resolveLanguageServerDefinitionLocations(view, editorPath, offset);
      const location = locations?.[0];
      if (!location) return;
      recordNavigationOrigin();
      await loadFileRef.current(
        location.path,
        location.range.start.line + 1,
        false,
        location.range.start.character,
      );
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [recordNavigationOrigin, resolveLanguageServerDefinitionLocations]);

  const requestLanguageServerHover = useCallback(async (
    view: EditorView,
    editorPath: string,
    offset: number,
  ): Promise<LanguageServerHoverResult | null> => {
    const language = languageServerLanguageForPath(editorPath);
    const getHover = workspace?.getLanguageServerHover;
    if (
      !language
      || !getHover
      || !canUseLanguageServer(language, languageServersRef.current)
    ) return null;
    try {
      const response = normalizeLanguageServerHoverResult(await getHover({
        language,
        path: editorPath,
        content: view.state.doc.toString(),
        version: nextLanguageServerDocumentVersion(editorPath),
        position: languageServerPositionAt(view, offset),
      }));
      if (editorViewRef.current !== view || editorPathRef.current !== editorPath) return null;
      return response;
    } catch {
      return null;
    }
  }, [nextLanguageServerDocumentVersion]);


  const cancelDiagnostics = useCallback((): void => {
    diagnosticsRequestSequence.current += 1;
    languageServerExpectationRef.current = null;
    if (diagnosticsTimerRef.current !== null) {
      window.clearTimeout(diagnosticsTimerRef.current);
      diagnosticsTimerRef.current = null;
    }
    if (languageServerFallbackTimerRef.current !== null) {
      window.clearTimeout(languageServerFallbackTimerRef.current);
      languageServerFallbackTimerRef.current = null;
    }
  }, []);

  const cancelSignatureHelp = useCallback((): void => {
    signatureHelpRequestSequence.current += 1;
  }, []);

  const resetLanguageServerRequests = useCallback((): void => {
    cancelDiagnostics();
    cancelSignatureHelp();
  }, [cancelDiagnostics, cancelSignatureHelp]);

  const isLanguageServerUsable = useCallback((language: LanguageServerLanguage): boolean => (
    canUseLanguageServer(language, languageServersRef.current)
  ), []);

  useEffect(() => () => {
    resetLanguageServerRequests();
    diagnosticsWorkerRef.current?.terminate();
    diagnosticsWorkerRef.current = null;
  }, [resetLanguageServerRequests]);

  return {
    cancelDiagnostics,
    cancelSignatureHelp,
    configureActiveLanguageServer,
    diagnostics,
    diagnosticsStatus,
    isLanguageServerUsable,
    languageServerCompletionSource,
    languageServerConfiguring,
    languageServers,
    loadReferencePreview,
    nextLanguageServerDocumentVersion,
    requestLanguageServerCodeActions,
    requestLanguageServerDefinition,
    requestLanguageServerHover,
    requestLanguageServerReferences,
    requestLanguageServerRename,
    requestLanguageServerSignatureHelp,
    resetLanguageServerRequests,
    resolveLanguageServerDefinitionLocations,
    scheduleEditorDiagnostics,
  };
}

export type WorkspaceLanguageServerController = ReturnType<typeof useWorkspaceLanguageServer>;
