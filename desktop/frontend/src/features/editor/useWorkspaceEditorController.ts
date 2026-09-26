import {
  findNext,
  findPrevious,
  replaceAll as replaceAllSearchMatches,
  replaceNext as replaceNextSearchMatch,
  selectMatches,
} from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { updateEditorStateDocument, type EditorPaneStore } from './editorPaneStore';
import { errorMessage as toErrorMessage } from '../../shared/errorMessage';
import { isWorkspacePathAtOrBelow, renameWorkspacePathPrefix } from '../../shared/workspacePaths';
import {
  cheshiDesktop as workspace,
  type LanguageServerLocation,
  type WorkspaceEntryMutation,
  type WorkspaceFileExcerptResult,
  type WorkspaceFileReadResult,
  type WorkspaceFileWriteResult,
} from '../../cheshiDesktop';
import { useCodeEditorSearch } from './codeEditorSearch';
import { languageServerLanguageForPath } from './languageServerDiagnostics';
import type { WorkspaceEditorAssistState } from './workspaceEditorAssistState';
import { DEFAULT_WORKSPACE_PROBLEMS_RATIO } from './WorkspaceProblemsResizer';
import {
  assertSourceExcerptReaderAvailable,
  isTabDirty,
  SOURCE_EXCERPT_CONTEXT_LINES,
  type WorkspaceTab,
} from './workspaceEditorModel';
import { confirmWorkspaceTabsClose } from './workspaceTabClose';
import { reorderWorkspaceTabs } from './workspaceTabOrder';
import { applyWorkspaceFileSaveResult, canSaveWorkspaceTab } from './workspaceFileSave';
import {
  canApplyWorkspaceFileLoad,
  createWorkspaceFileLoadTracker,
  normalizeWorkspaceEditorContent,
} from './workspaceFileLoad';
import { useWorkspaceCodeEditor } from './useWorkspaceCodeEditor';
import { useWorkspaceCodeExplanation } from './useWorkspaceCodeExplanation';
import { useWorkspaceLanguageServer } from './useWorkspaceLanguageServer';

import { useWorkspaceEditorEdits } from './useWorkspaceEditorEdits';
import { useWorkspaceEditorNavigation } from './useWorkspaceEditorNavigation';
import { createWorkspaceRequestTracker } from './workspaceEditorRequest';
import type { PendingWorkspaceRename } from './useWorkspaceAssistRequests';

export interface WorkspaceEditorTarget {
  path: string;
  line?: number | null;
  requestId: number;
}

export type WorkspaceEditorMutation = WorkspaceEntryMutation & { requestId: number };

const emptyTabs: WorkspaceTab[] = [];

export interface EditorPaneBinding { store: EditorPaneStore; id: string; ready: boolean; }

interface UseWorkspaceEditorControllerOptions {
  pane: EditorPaneBinding;
  active: boolean;
  mutation: WorkspaceEditorMutation | null;
  target: WorkspaceEditorTarget | null;
  onAllTabsClosed: () => void;
}

export function useWorkspaceEditorController({
  pane,
  active,
  mutation,
  target,
  onAllTabsClosed,
}: UseWorkspaceEditorControllerOptions) {
  const paneState = useSyncExternalStore(pane.store.subscribe, pane.store.getSnapshot);
  const group = paneState.groups[pane.id];
  const tabs = group?.tabs ?? emptyTabs;
  const selectedPath = group?.selectedPath ?? null;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = pane.store.saving;
  const [errorMessage, setErrorMessage] = useState('');
  const problemsOpen = group?.problemsOpen ?? true;
  const problemsRatio = group?.problemsRatio ?? DEFAULT_WORKSPACE_PROBLEMS_RATIO;
  const setProblemsOpen = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    const current = pane.store.getSnapshot().groups[pane.id]?.problemsOpen ?? true;
    pane.store.configure(pane.id, { problemsOpen: typeof value === 'function' ? value(current) : value });
  }, [pane.store, pane.id]);
  const setProblemsRatio = useCallback((value: number) => pane.store.configure(pane.id, { problemsRatio: value }), [pane.store, pane.id]);
  const [assistState, setAssistState] = useState<WorkspaceEditorAssistState | null>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const assistStateRef = useRef(assistState);
  const editorViewRef = useRef<EditorView | null>(null);
  const editorPathRef = useRef<string | null>(null);
  const referencePreviewRequestSequence = useRef(0);
  const pendingLineRef = useRef<number | null>(null);
  const pendingCharacterRef = useRef<number | null>(null);
  const pendingRenameRef = useRef<PendingWorkspaceRename | null>(null);
  const assistRequests = useMemo(createWorkspaceRequestTracker, []);
  const loadFileRef = useRef<(
    relativePath: string,
    lineNumber?: number | null,
    forceReload?: boolean,
    character?: number | null,
  ) => Promise<void>>(async () => undefined);
  const fileLoadTracker = useMemo(createWorkspaceFileLoadTracker, []);
  const nextTabGeneration = pane.store.nextGeneration;
  const tabsRef = useRef(tabs);
  const selectedPathRef = useRef(selectedPath);
  tabsRef.current = tabs;
  selectedPathRef.current = selectedPath;
  assistStateRef.current = assistState;

  const {
    editorSearchOpen,
    editorSearchControls,
    editorSearchInputRef,
    editorSearchQueryValid,
    updateEditorSearchControls,
    openEditorSearch,
    closeEditorSearch,
    runEditorSearchCommand,
    syncEditorSearchPanel,
  } = useCodeEditorSearch(editorViewRef);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === selectedPath) ?? null,
    [selectedPath, tabs],
  );
  const currentFile = activeTab?.file ?? null;
  const codeExplanation = useWorkspaceCodeExplanation({
    active,
    path: selectedPath,
    firstLine: activeTab?.sourceExcerpt?.startLine ?? 1,
    lineEnding: activeTab?.sourceExcerpt ? null : currentFile?.lineEnding,
    editorViewRef,
  });
  const activeLanguageServerLanguage = currentFile ? languageServerLanguageForPath(currentFile.path) : null;
  const problemsVisible = problemsOpen && currentFile?.fileKind === 'text';
  const isDirty = activeTab ? isTabDirty(activeTab) : false;
  const conflictMessage = activeTab?.conflictMessage ?? '';

  const invalidatePendingFileLoad = useCallback((): void => {
    fileLoadTracker.invalidate();
    setLoading(false);
  }, [fileLoadTracker]);

  useEffect(() => {
    assistRequests.invalidate();
    referencePreviewRequestSequence.current += 1;
    pendingRenameRef.current = null;
    setAssistState(null);
    invalidatePendingFileLoad();
  }, [selectedPath, assistRequests, invalidatePendingFileLoad]);

  const toggleEditorSearch = (): void => {
    if (editorSearchOpen) {
      closeEditorSearch();
      return;
    }
    const view = editorViewRef.current;
    if (view) openEditorSearch(view);
  };

  const selectPath = useCallback((path: string | null): void => {
    if (path !== selectedPathRef.current) {
      assistRequests.invalidate();
      referencePreviewRequestSequence.current += 1;
      pendingRenameRef.current = null;
      setAssistState(null);
    }
    selectedPathRef.current = path;
    pane.store.select(pane.id, path);
  }, [pane.store, pane.id]);

  const replaceTabs = useCallback((update: (current: WorkspaceTab[]) => WorkspaceTab[]): void => {
    pane.store.replace(pane.id, update);
    tabsRef.current = pane.store.getSnapshot().groups[pane.id]?.tabs ?? [];
  }, [pane.store, pane.id]);

  const reorderTab = useCallback((source: string, target: string, side: 'before' | 'after') => {
    replaceTabs(current => reorderWorkspaceTabs(current, source, target, side));
  }, [replaceTabs]);

  const sessionReady = pane.ready;

  const updateTab = useCallback((path: string, update: (tab: WorkspaceTab) => WorkspaceTab): void => {
    replaceTabs((current) => current.map((tab) => tab.path === path ? update(tab) : tab));
  }, [replaceTabs]);
  const documentTabsRef = useMemo(() => ({ get current() { return pane.store.allTabs(); } }), [pane.store]);
  const replaceDocuments = useCallback((update: (tabs: WorkspaceTab[]) => WorkspaceTab[]) => {
    pane.store.replaceDocuments(update);
  }, [pane.store]);
  const shouldFocus = useCallback(() => pane.store.getSnapshot().activeId === pane.id, [pane.store, pane.id]);

  const { navigationAvailability, recordNavigationOrigin, navigateHistory, renameNavigationPath, removeNavigationPath }
    = useWorkspaceEditorNavigation({ selectedPathRef, editorViewRef, tabsRef, loadFileRef });

  const activateOpenTab = useCallback((path: string): void => {
    if (!tabsRef.current.some((tab) => tab.path === path)) return;
    invalidatePendingFileLoad();
    if (path === selectedPathRef.current) return;
    recordNavigationOrigin();
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    selectPath(path);
  }, [invalidatePendingFileLoad, recordNavigationOrigin, selectPath]);

  const languageServer = useWorkspaceLanguageServer({
    activeLanguageServerLanguage,
    editorPathRef,
    editorViewRef,
    loadFileRef,
    pendingRenameRef,
    assistRequests,
    recordNavigationOrigin,
    referencePreviewRequestSequence,
    setAssistState,
    setErrorMessage,
  });
  const {
    configureActiveLanguageServer,
    diagnostics,
    diagnosticsStatus,
    languageServerConfiguring,
    languageServers,
    loadReferencePreview,
    nextLanguageServerDocumentVersion,
    requestLanguageServerCodeActions,
    requestLanguageServerReferences,
    requestLanguageServerRename,
    resetLanguageServerRequests,
  } = languageServer;
  const activeLanguageServer = activeLanguageServerLanguage
    ? languageServers.find((status) => status.language === activeLanguageServerLanguage) ?? null
    : null;

  const closeAssist = useCallback((): void => {
    assistRequests.invalidate();
    referencePreviewRequestSequence.current += 1;
    pendingRenameRef.current = null;
    setAssistState(null);
    editorViewRef.current?.focus();
  }, [assistRequests]);

  const {
    closeTabRef,
    createEditor,
    createSourceExcerptViewer,
    destroyEditor,
    revealDiagnostic,
    revealLine,
    saveFileRef,
  } = useWorkspaceCodeEditor({
    shouldFocus,
    activateOpenTab,
    assistStateRef,
    editorHostRef,
    editorPathRef,
    editorViewRef,
    languageServer,
    navigateHistory,
    openEditorSearch,
    recordNavigationOrigin,
    closeAssist,
    syncEditorSearchPanel,
    tabsRef,
    updateTab,
  });

  useEffect(() => {
    if (!active || !activeTab || (activeTab.file.fileKind !== 'text' && !activeTab.sourceExcerpt)) {
      destroyEditor();
      return;
    }
    const lineNumber = pendingLineRef.current;
    const character = pendingCharacterRef.current;
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    const frame = requestAnimationFrame(() => {
      if (activeTab.file.fileKind === 'text') {
        createEditor(activeTab, lineNumber, character);
      } else {
        createSourceExcerptViewer(activeTab, lineNumber, character);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    active,
    activeTab?.loadGeneration,
    activeTab?.path,
    createEditor,
    createSourceExcerptViewer,
    destroyEditor,
  ]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || !activeTab || editorPathRef.current !== activeTab.path
      || view.state.doc.toString() === activeTab.draftContent) return;
    const next = updateEditorStateDocument(view.state, activeTab.draftContent);
    if (next) view.setState(next);
  }, [activeTab?.draftContent, activeTab?.path]);

  const activateTab = useCallback((
    path: string,
    lineNumber?: number | null,
    character?: number | null,
  ): void => {
    const tab = tabsRef.current.find((candidate) => candidate.path === path);
    if (!tab) return;
    if (path === selectedPathRef.current) {
      const displayedLine = lineNumber && tab.sourceExcerpt
        ? lineNumber - tab.sourceExcerpt.startLine + 1
        : lineNumber;
      revealLine(displayedLine, character ?? 0);
      return;
    }
    pendingLineRef.current = lineNumber ?? null;
    pendingCharacterRef.current = character ?? null;
    selectPath(path);
  }, [revealLine, selectPath]);

  const closeTab = useCallback((path: string | null): void => {
    if (!path) return;
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.path === path);
    const tab = current[index];
    if (!tab) return;
    if (!confirmWorkspaceTabsClose([tab], candidate => isTabDirty(candidate) && !pane.store.sharedElsewhere(pane.id, candidate.path), (dirtyPath) => window.confirm(`Discard unsaved changes in ${dirtyPath}?`))) return;
    invalidatePendingFileLoad();
    const nextTabs = current.filter((candidate) => candidate.path !== path);
    replaceTabs(() => nextTabs);
    if (nextTabs.length === 0) {
      pendingLineRef.current = null;
      pendingCharacterRef.current = null;
      selectPath(null);
      if (active) onAllTabsClosed();
      return;
    }
    if (selectedPathRef.current !== path) return;
    const nextTab = nextTabs[index] ?? nextTabs[index - 1] ?? null;
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    selectPath(nextTab?.path ?? null);
  }, [active, invalidatePendingFileLoad, onAllTabsClosed, replaceTabs, selectPath]);
  closeTabRef.current = closeTab;

  const closeAllTabs = useCallback((): void => {
    const current = tabsRef.current;
    if (current.length === 0) return;
    if (!confirmWorkspaceTabsClose(current, candidate => isTabDirty(candidate) && !pane.store.sharedElsewhere(pane.id, candidate.path), (path) => window.confirm(`Discard unsaved changes in ${path}?`))) return;
    invalidatePendingFileLoad();
    replaceTabs(() => []);
    pendingLineRef.current = null;
    pendingCharacterRef.current = null;
    selectPath(null);
    if (active) onAllTabsClosed();
  }, [active, invalidatePendingFileLoad, onAllTabsClosed, replaceTabs, selectPath]);

  const copyTabFullPath = useCallback(async (path: string): Promise<void> => {
    if (!workspace?.copyWorkspaceEntryFullPath) {
      setErrorMessage('Electron Workspace clipboard API is unavailable.');
      return;
    }
    try {
      await workspace.copyWorkspaceEntryFullPath(path);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!mutation) return;
    invalidatePendingFileLoad();
    const currentTabs = tabsRef.current;

    if (mutation.type === 'renamed' || mutation.type === 'moved') {
      renameNavigationPath(mutation.previousPath, mutation.path);
      if (!currentTabs.some((tab) => isWorkspacePathAtOrBelow(tab.path, mutation.previousPath))) return;
      if (editorPathRef.current && isWorkspacePathAtOrBelow(editorPathRef.current, mutation.previousPath)) {
        destroyEditor(false);
      }
      const nextTabs = currentTabs.map((tab) => {
        if (!isWorkspacePathAtOrBelow(tab.path, mutation.previousPath)) return tab;
        const nextPath = renameWorkspacePathPrefix(tab.path, mutation.previousPath, mutation.path);
        return {
          ...tab,
          path: nextPath,
          file: {
            ...tab.file,
            path: nextPath,
            name: nextPath.split('/').at(-1) ?? nextPath,
          },
          sourceExcerpt: tab.sourceExcerpt ? {
            ...tab.sourceExcerpt,
            file: {
              ...tab.sourceExcerpt.file,
              path: nextPath,
              name: nextPath.split('/').at(-1) ?? nextPath,
            },
          } : null,
          loadGeneration: ++nextTabGeneration.current,
          editorState: undefined,
        };
      });
      replaceTabs(() => nextTabs);
      const currentSelectedPath = selectedPathRef.current;
      if (currentSelectedPath && isWorkspacePathAtOrBelow(currentSelectedPath, mutation.previousPath)) {
        pendingLineRef.current = null;
        pendingCharacterRef.current = null;
        selectPath(renameWorkspacePathPrefix(currentSelectedPath, mutation.previousPath, mutation.path));
      }
      return;
    }

    const selectedIndex = currentTabs.findIndex((tab) => tab.path === selectedPathRef.current);
    removeNavigationPath(mutation.path);
    const affectedTabs = currentTabs.filter((tab) => isWorkspacePathAtOrBelow(tab.path, mutation.path));
    if (affectedTabs.length === 0) return;
    if (editorPathRef.current && isWorkspacePathAtOrBelow(editorPathRef.current, mutation.path)) {
      destroyEditor(false);
    }
    const nextTabs = currentTabs.filter((tab) => !isWorkspacePathAtOrBelow(tab.path, mutation.path));
    replaceTabs(() => nextTabs);
    if (nextTabs.length === 0) {
      pendingLineRef.current = null;
      pendingCharacterRef.current = null;
      selectPath(null);
      onAllTabsClosed();
      return;
    }
    if (selectedPathRef.current && isWorkspacePathAtOrBelow(selectedPathRef.current, mutation.path)) {
      const nextTab = nextTabs[Math.min(Math.max(selectedIndex, 0), nextTabs.length - 1)];
      pendingLineRef.current = null;
      pendingCharacterRef.current = null;
      selectPath(nextTab?.path ?? null);
    }
  }, [
    active,
    destroyEditor,
    invalidatePendingFileLoad,
    mutation,
    onAllTabsClosed,
    replaceTabs,
    selectPath,
    renameNavigationPath,
    removeNavigationPath,
  ]);

  const loadFile = useCallback(async (
    relativePath: string,
    lineNumber?: number | null,
    forceReload = false,
    character?: number | null,
  ): Promise<void> => {
    invalidatePendingFileLoad();
    const existing = tabsRef.current.find((tab) => tab.path === relativePath);
    const shared = pane.store.allTabs().find(tab => tab.path === relativePath);
    if (!existing && shared && !forceReload && !shared.sourceExcerpt && shared.file.fileKind !== 'too_large') {
      replaceTabs(current => [...current, shared]);
      activateTab(relativePath, lineNumber, character);
      return;
    }
    const requestedLine = lineNumber ?? (forceReload ? existing?.sourceExcerpt?.targetLine ?? null : null);
    const existingExcerpt = existing?.sourceExcerpt;
    const needsSourceExcerpt = Boolean(
      requestedLine
      && existing?.file.fileKind === 'too_large'
      && (
        !existingExcerpt
        || requestedLine < existingExcerpt.startLine
        || requestedLine > existingExcerpt.endLine
      ),
    );
    if (existing && !forceReload && !needsSourceExcerpt) {
      activateTab(relativePath, requestedLine, character);
      return;
    }
    if (!workspace?.readWorkspaceFile) {
      setErrorMessage('Electron Workspace API is unavailable.');
      return;
    }
    const sequence = fileLoadTracker.begin();
    setLoading(true);
    setErrorMessage('');
    try {
      const response: WorkspaceFileReadResult = await workspace.readWorkspaceFile(relativePath);
      if (!fileLoadTracker.isCurrent(sequence)) return;
      let sourceExcerpt: WorkspaceFileExcerptResult | null = null;
      if (response.file.fileKind === 'too_large' && requestedLine) {
        const readSourceExcerpt = workspace.readWorkspaceFileExcerpt;
        assertSourceExcerptReaderAvailable(readSourceExcerpt);
        sourceExcerpt = await readSourceExcerpt({
          path: relativePath,
          line: requestedLine,
          contextLines: SOURCE_EXCERPT_CONTEXT_LINES,
        });
        if (!fileLoadTracker.isCurrent(sequence)) return;
      }
      if (!canApplyWorkspaceFileLoad(existing, tabsRef.current.find((tab) => tab.path === relativePath))) return;
      const content = normalizeWorkspaceEditorContent(response.content ?? '');
      const nextTab: WorkspaceTab = {
        path: relativePath,
        file: sourceExcerpt?.file ?? response.file,
        previewDataUrl: response.dataUrl,
        sourceExcerpt,
        savedContent: content,
        draftContent: content,
        conflictMessage: null,
        loadGeneration: ++nextTabGeneration.current,
      };
      if (forceReload && relativePath === selectedPathRef.current) destroyEditor(false);
      replaceTabs((current) => {
        const index = current.findIndex((tab) => tab.path === relativePath);
        if (index < 0) return [...current, nextTab];
        const next = [...current];
        next[index] = nextTab;
        return next;
      });
      pendingLineRef.current = requestedLine;
      pendingCharacterRef.current = character ?? null;
      selectPath(relativePath);
    } catch (error) {
      if (fileLoadTracker.isCurrent(sequence)) setErrorMessage(toErrorMessage(error));
    } finally {
      if (fileLoadTracker.isCurrent(sequence)) setLoading(false);
    }
  }, [activateTab, destroyEditor, fileLoadTracker, invalidatePendingFileLoad, replaceTabs, selectPath]);
  loadFileRef.current = loadFile;

  const selectReference = useCallback((index: number): void => {
    const current = assistStateRef.current;
    if (current?.kind !== 'references') return;
    const location = current.locations[index];
    if (location) void loadReferencePreview(location, index);
  }, [loadReferencePreview]);

  const openReference = useCallback((location: LanguageServerLocation): void => {
    recordNavigationOrigin();
    closeAssist();
    void loadFileRef.current(
      location.path,
      location.range.start.line + 1,
      false,
      location.range.start.character,
    );
  }, [closeAssist, recordNavigationOrigin]);

  const { chooseCodeAction, changeRenameValue, submitRename, applyPreparedWorkspaceEdit } = useWorkspaceEditorEdits({
    assistStateRef, assistRequests, pendingRenameRef, editorViewRef, editorPathRef, selectedPathRef,
    tabsRef: documentTabsRef, nextTabGeneration, nextLanguageServerDocumentVersion, destroyEditor, replaceTabs: replaceDocuments,
    setAssistState, setErrorMessage,
  });

  const saveFile = useCallback(async (): Promise<void> => {
    const tab = tabsRef.current.find((candidate) => candidate.path === selectedPathRef.current);
    if (!canSaveWorkspaceTab(tab, savingRef.current)) return;
    if (!workspace?.writeWorkspaceFile) {
      setErrorMessage('Electron Workspace API is unavailable.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrorMessage('');
    try {
      const response: WorkspaceFileWriteResult = await workspace.writeWorkspaceFile({
        path: tab.file.path,
        content: tab.draftContent,
        expectedRevision: tab.file.revision,
        hasBom: tab.file.hasBom,
        lineEnding: tab.file.lineEnding,
      });
      updateTab(tab.path, (current) => applyWorkspaceFileSaveResult(current, tab, response));
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [updateTab]);
  saveFileRef.current = saveFile;

  useEffect(() => {
    if (!active) {
      invalidatePendingFileLoad();
      return;
    }
    if (!target || !sessionReady) return;
    void loadFile(target.path, target.line);
  }, [active, invalidatePendingFileLoad, loadFile, target, sessionReady]);

  useEffect(() => {
    const getWorkspaceFileVersion = workspace?.getWorkspaceFileVersion;
    if (!active || loading || !selectedPath || !currentFile || !getWorkspaceFileVersion) return;
    let cancelled = false;
    const poller = window.setInterval(() => {
      void (async () => {
        try {
          const latest = await getWorkspaceFileVersion(selectedPath);
          if (cancelled || selectedPathRef.current !== selectedPath) return;
          const tab = tabsRef.current.find((candidate) => candidate.path === selectedPath);
          if (!tab || latest.revision === tab.file.revision) return;
          if (isTabDirty(tab)) {
            updateTab(tab.path, (current) => ({
              ...current,
              file: latest,
              conflictMessage: 'This file changed outside the editor. Save is disabled until you reload it.',
            }));
            return;
          }
          await loadFile(selectedPath, tab.sourceExcerpt?.targetLine ?? null, true);
        } catch {
          // A later poll or explicit file-open request reports transient failures.
        }
      })();
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(poller);
    };
  }, [active, currentFile?.revision, loadFile, loading, selectedPath, updateTab]);

  useEffect(() => () => {
    fileLoadTracker.invalidate();
    resetLanguageServerRequests();
    editorViewRef.current?.destroy();
    editorViewRef.current = null;
    editorPathRef.current = null;
  }, [fileLoadTracker, resetLanguageServerRequests]);

  useEffect(() => {
    return pane.store.registerCapture(pane.id, () => {
      invalidatePendingFileLoad();
      const view = editorViewRef.current;
      const path = editorPathRef.current;
      if (view && path) updateTab(path, tab => ({ ...tab, editorState: view.state, draftContent: view.state.doc.toString() }));
    });
  }, [pane.store, pane.id, updateTab, invalidatePendingFileLoad]);
  useEffect(() => {
    pane.store.setBusy(pane.id, loading || (assistState?.kind === 'edit-preview' && assistState.applying));
    return () => pane.store.setBusy(pane.id, false);
  }, [pane.store, pane.id, loading, assistState]);

  const requestReferencesAtSelection = (): void => {
    const view = editorViewRef.current;
    const path = editorPathRef.current;
    if (view && path) void requestLanguageServerReferences(view, path, view.state.selection.main.head);
  };

  const requestCodeActionsAtSelection = (): void => {
    const view = editorViewRef.current;
    const path = editorPathRef.current;
    if (view && path) void requestLanguageServerCodeActions(view, path);
  };

  const requestRenameAtSelection = (): void => {
    const view = editorViewRef.current;
    const path = editorPathRef.current;
    if (view && path) void requestLanguageServerRename(view, path, view.state.selection.main.head);
  };

  const reloadSelectedFile = (): void => {
    if (selectedPath) void loadFile(selectedPath, target?.line, true);
  };

  return {
    active,
    activeLanguageServer,
    activeTab,
    activateOpenTab,
    applyPreparedWorkspaceEdit,
    assistState,
    changeRenameValue,
    chooseCodeAction,
    closeAllTabs,
    closeAssist,
    closeEditorSearch,
    closeTab,
    configureActiveLanguageServer,
    codeExplanation,
    conflictMessage,
    copyTabFullPath,
    currentFile,
    diagnostics,
    diagnosticsStatus,
    editorHostRef,
    editorSearchControls,
    editorSearchInputRef,
    editorSearchOpen,
    editorSearchQueryValid,
    errorMessage,
    findNextMatch: () => runEditorSearchCommand(findNext),
    findPreviousMatch: () => runEditorSearchCommand(findPrevious),
    isDirty,
    languageServerConfiguring,
    languageServers,
    loadFile,
    loading,
    navigateHistory,
    navigationAvailability,
    openReference,
    problemsOpen,
    problemsRatio,
    problemsVisible,
    reloadSelectedFile,
    reorderTab,
    replaceAllMatches: () => runEditorSearchCommand(replaceAllSearchMatches),
    replaceNextMatch: () => runEditorSearchCommand(replaceNextSearchMatch),
    requestCodeActionsAtSelection,
    requestReferencesAtSelection,
    requestRenameAtSelection,
    revealDiagnostic,
    saveFile,
    saving,
    selectAllMatches: () => runEditorSearchCommand(selectMatches),
    selectedPath,
    selectReference,
    setProblemsOpen,
    setProblemsRatio,
    submitRename,
    tabs,
    toggleEditorSearch,
    updateEditorSearchControls,
  };
}
